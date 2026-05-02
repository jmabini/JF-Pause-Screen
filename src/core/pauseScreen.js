import { CONFIG } from '../config.js';
import { 
  makeLRUCache, 
  makeLRUBlobCache, 
  sanitizeHTML, 
  formatClock 
} from '../utils/helpers.js';
import { 
  applyThemeColor, 
  isPortrait,
  isPhoneLandscape,
  isPhonePortrait,
  isTabletLandscape,
  getItemId,
  directorRequest
} from '../services/image.js';
import { getStyles } from '../ui/styles.js';
import { createOverlay } from '../ui/elements.js';

export function initPauseScreen(bootObserver) {
  // --- INTERNAL STATE ---
  let video = null, mouseTimer = null, fetchAbort = null;
  let currentItemId = null, renderedItemId = null, prefetchRetryTimer = null, pauseShowTimer = null;
  let resizeObserver = null, resizeDebounce = null, lastPauseTime = 0, globalPauseTime = 0, isAdjusting = false;
  
  const itemCache = makeLRUCache(50);
  const imgBlobCache = makeLRUBlobCache(CONFIG.blobCacheMaxSize);
  
  let currentCroppedLogoUrl = null;
  let activeBackdropItemId = null;
  let maxBackdropIndex = null;
  let backdropTags = [];
  let authHeaders = {};
  let activeBackdropIndex = 0;
  let backdropCycleTimer = null;
  let isFallbackPrimary = false;

  let touchStartX = 0, touchStartY = 0, touchResumeReady = false, touchReadyTimer = null;
  let scrollRAF = null, lastFrameTime = 0;
  let spacerEl = null, cloneEl = null, originalTextHTML = '';
  let isDismissed = false, dismissTimer = null, isOverlayVisible = false;
  let isFingerDown = false, isUserScrolling = false, userScrollTimeout = null;
  let currentScrollY = 0;
  let manualScrollEndTime = 0;
  let hasStartedPlaying = false;

  // --- IDLE SCREENSAVER STATE ---
  let idleTimer = null, isScreensaver = false;
  let ssLogoX = 0, ssLogoY = 0, ssVelX = 1, ssVelY = 0.7, ssRaf = null, ssStartTime = 0;
  let chapterTicksData = [];

  // --- UI SETUP ---
  if (!document.getElementById('pause-overlay-style')) {
    const styleEl = document.createElement('style');
    styleEl.id = 'pause-overlay-style';
    styleEl.textContent = getStyles();
    document.head.appendChild(styleEl);
  }

  const UI = createOverlay();
  const { 
    overlay, bgBackdropEl, fgBackdropEl, logoEl, titleEl, episodeEl, 
    metaYear, metaRating, metaRuntime, metaGenres, metaStar, synopsisEl, 
    rightCol, discEl, progressFill, progressTime, progressPct, progressEnd,
    chapterTicksEl, screensaverLogoEl
  } = UI;

  // --- CORE ENGINE FUNCTIONS ---

  function stopScrollAnimation() { if (scrollRAF) { cancelAnimationFrame(scrollRAF); scrollRAF = null; } }
  function detachScrollDOM() { if (spacerEl?.parentNode) spacerEl.parentNode.removeChild(spacerEl); if (cloneEl?.parentNode) cloneEl.parentNode.removeChild(cloneEl); }
  function initScrollDOM() { if (!spacerEl) { spacerEl = document.createElement('div'); spacerEl.style.flexShrink = '0'; } if (!cloneEl) cloneEl = document.createElement('div'); }
  function easeOutQuad(t) { return t * (2 - t); }

  function startScrollAnimation() {
    stopScrollAnimation(); detachScrollDOM(); initScrollDOM();
    const cs = window.getComputedStyle(synopsisEl);
    let lineHeight = parseFloat(cs.lineHeight);
    if (isNaN(lineHeight) || lineHeight < 5) lineHeight = parseFloat(cs.fontSize) * 1.5;

    // Preserve scroll position if we're resuming after manual scroll
    const preservePosition = manualScrollEndTime > 0;
    const savedScrollY = preservePosition ? currentScrollY : 0;

    spacerEl.style.height = `${Math.ceil(lineHeight * 2)}px`;
    synopsisEl.innerHTML = originalTextHTML;
    void synopsisEl.offsetHeight;

    if (synopsisEl.scrollHeight <= Math.ceil(synopsisEl.clientHeight) + 1) {
      synopsisEl.scrollTop = 0;
      synopsisEl.style.webkitMaskImage = 'none';
      synopsisEl.style.maskImage = 'none';
      return;
    }

    const maskCSS = 'linear-gradient(to bottom, black 0%, black calc(100% - 30px), transparent 100%)';
    synopsisEl.style.webkitMaskImage = maskCSS;
    synopsisEl.style.maskImage = maskCSS;

    synopsisEl.innerHTML = '';
    const originalBlock = document.createElement('div');
    originalBlock.innerHTML = originalTextHTML;
    synopsisEl.appendChild(originalBlock);
    synopsisEl.appendChild(spacerEl); 
    cloneEl.innerHTML = originalTextHTML; 
    synopsisEl.appendChild(cloneEl);

    const originalRect = originalBlock.getBoundingClientRect();
    const cloneRect = cloneEl.getBoundingClientRect();
    const loopResetPoint = cloneRect.top - originalRect.top;

    // Restore position if preserving, otherwise start from top
    currentScrollY = preservePosition ? Math.min(savedScrollY, loopResetPoint - 1) : 0;
    synopsisEl.scrollTop = currentScrollY;
    if (!preservePosition) {
      isUserScrolling = false;
      isFingerDown = false;
    }

    const fullSpeed = CONFIG.synopsis.scroll.linesPerSecond * lineHeight;
    const holdMs = CONFIG.synopsis.scroll.initialHoldMs;
    const rampMs = CONFIG.synopsis.scroll.scrollRampMs || 800;
    const resumeRampMs = CONFIG.synopsis.scroll.scrollResumeRampMs || 2000;

    lastFrameTime = performance.now();

    function animate(currentTime) {
      if (!lastFrameTime) lastFrameTime = currentTime;
      const delta = currentTime - lastFrameTime;
      lastFrameTime = currentTime;

      const timeSincePause = performance.now() - globalPauseTime;

      if (isUserScrolling || isFingerDown) {
        // While user is interacting, keep internal Y synced with DOM
        currentScrollY = synopsisEl.scrollTop;
        
        // Handle loop wrap-around even during manual scroll
        if (currentScrollY >= loopResetPoint) {
          currentScrollY -= loopResetPoint;
          synopsisEl.scrollTop = currentScrollY;
        }
        scrollRAF = requestAnimationFrame(animate);
        return;
      }

      // Calculate speed multiplier: ramp up after initial pause OR after manual scroll
      let speedMultiplier = 1;

      if (timeSincePause < holdMs && manualScrollEndTime === 0) {
        currentScrollY = 0;
        scrollRAF = requestAnimationFrame(animate);
        return;
      } else if (timeSincePause < holdMs + rampMs && manualScrollEndTime === 0) {
        // Initial ramp after pause (only if not resuming from manual scroll)
        speedMultiplier = easeOutQuad(Math.min((timeSincePause - holdMs) / rampMs, 1));
      }

      // After manual scroll ended, smoothly ease into auto-scroll speed.
      // Uses a floor of 30% speed so there is never a full stop — the text
      // seamlessly transitions from inertia deceleration to auto-scroll.
      if (manualScrollEndTime > 0) {
        const timeSinceResume = performance.now() - manualScrollEndTime;
        if (timeSinceResume < resumeRampMs) {
          const t = timeSinceResume / resumeRampMs;
          const MIN_SPEED = 0.3; // Never fully stop
          speedMultiplier *= MIN_SPEED + (1 - MIN_SPEED) * easeOutQuad(t);
        } else {
          manualScrollEndTime = 0; // Ramp complete, clear flag
        }
      }

      currentScrollY += (fullSpeed * speedMultiplier * delta) / 1000;
      synopsisEl.scrollTop = currentScrollY;

      if (currentScrollY >= loopResetPoint) {
        currentScrollY -= loopResetPoint;
        synopsisEl.scrollTop = currentScrollY;
      }
      scrollRAF = requestAnimationFrame(animate);
    }
    scrollRAF = requestAnimationFrame(animate);
  }

  async function adjustLayout() {
    if (isAdjusting) return;
    if (isUserScrolling || isFingerDown) return;
    isAdjusting = true;
    
    const expectedItemId = currentItemId;
    
    try {
      const isPhone = isPhonePortrait(), isLandPhone = isPhoneLandscape(), isTabLand = isTabletLandscape(), portrait = isPortrait(), SY = CONFIG.synopsis;
      stopScrollAnimation(); detachScrollDOM();

      synopsisEl.style.maxHeight = 'none'; synopsisEl.style.fontSize = ''; synopsisEl.style.webkitLineClamp = 'unset'; synopsisEl.style.webkitBoxOrient = 'unset';
      synopsisEl.innerHTML = originalTextHTML;
      void synopsisEl.offsetHeight;

      const leftCol = overlay.querySelector('.ps-left');
      const availableHeight = Math.max(0, leftCol.getBoundingClientRect().bottom - synopsisEl.getBoundingClientRect().top - SY.descenderGuardPx);
      const synopsisWidth = synopsisEl.getBoundingClientRect().width;
      syncPauseBadgeSizing();
      let maxSize, minSize;

      if (portrait) {
        maxSize = isPhone ? parsePx(CONFIG.fonts.phonePortrait.synopsis) : parsePx(CONFIG.fonts.tabletPortrait.synopsis);
        minSize = isPhone ? SY.minPhonePortrait : (SY.minTabletPortrait || SY.minDefault);
      }
      else if (isLandPhone) { maxSize = parsePx(CONFIG.fonts.phoneLandscape.synopsis); minSize = SY.minPhoneLandscape; }
      else if (isTabLand) { maxSize = parsePx(CONFIG.fonts.tabletLandscape.synopsis); minSize = SY.minTabletLandscape; }
      else if (window.innerWidth >= 2000) { maxSize = parsePx(CONFIG.fonts.largeScreen.synopsis); minSize = SY.minLargeScreen || SY.minDefault; }
      else { maxSize = parsePx(CONFIG.fonts.desktop.synopsis); minSize = SY.minDefault; }

      let bestFit = minSize;

      try {
        if (!originalTextHTML) throw new Error('empty');
        const res = await directorRequest('measureText', {
          text: originalTextHTML,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          width: synopsisWidth,
          minSize,
          maxSize,
          availableHeight,
          lineHeightMultiplier: 1.5,
          measureScale: CONFIG.measureScale || 1
        }, fetchAbort?.signal);
        
        if (currentItemId !== expectedItemId) return;
        bestFit = res.bestFit;
      } catch (err) {
        if (currentItemId !== expectedItemId) return;
        
        const clone = synopsisEl.cloneNode(true);
        clone.style.visibility = 'hidden';
        clone.style.position = 'absolute';
        clone.style.pointerEvents = 'none';
        clone.style.width = window.getComputedStyle(synopsisEl).width;
        clone.style.height = 'auto';
        clone.style.maxHeight = 'none';
        clone.style.flex = 'none';
        clone.style.contain = 'layout paint';

        synopsisEl.parentNode.insertBefore(clone, synopsisEl.nextSibling);

        let low = minSize, high = maxSize;
        while (low <= high) {
          const mid = low + (high - low) / 2; clone.style.fontSize = mid + 'px';
          if (clone.scrollHeight <= availableHeight) { bestFit = mid; low = mid + 0.25; } else { high = mid - 0.25; }
        }
        clone.remove();
      }

      synopsisEl.style.fontSize = bestFit + 'px';
      synopsisEl.style.maxHeight = availableHeight + 'px';
    } finally {
      requestAnimationFrame(() => { isAdjusting = false; if (currentItemId === expectedItemId) startScrollAnimation(); });
    }
  }

  function syncPauseBadgeSizing() {
    const badgeConfig = CONFIG.pauseBadge || {};
    const landscapeWidthPct = badgeConfig.landscapeWidthPctOfDisc || 46;
    const portraitPhoneWidthPct = badgeConfig.portraitPhoneWidthPct || 42;
    const portraitTabletWidthPct = badgeConfig.portraitTabletWidthPct || 28;
    const landscapeTopPct = badgeConfig.landscapeTopPct || 62;
    const rightWidth = rightCol.getBoundingClientRect().width || 0;
    const landscapeWidth = rightWidth * landscapeWidthPct / 100;
    const portraitWidthPct = isPhonePortrait() ? portraitPhoneWidthPct : portraitTabletWidthPct;
    const portraitWidth = window.innerWidth * portraitWidthPct / 100;

    overlay.style.setProperty('--pause-badge-landscape-width', `${Math.max(0, landscapeWidth)}px`);
    overlay.style.setProperty('--pause-badge-portrait-width', `${Math.max(0, portraitWidth)}px`);
    overlay.style.setProperty('--pause-badge-top', `${landscapeTopPct}%`);
  }

  function parsePx(val) { const n = parseFloat(val); return isNaN(n) ? 20 : (String(val).trim().endsWith('vw') ? n * window.innerWidth / 100 : n); }

  async function fetchAsBlob(url, signal) {
    if (imgBlobCache.has(url)) return imgBlobCache.get(url);
    try {
      const sig = signal || fetchAbort?.signal;
      const opts = sig ? { signal: sig, headers: authHeaders } : { headers: authHeaders };
      const resp = await fetch(url, opts);
      if (!resp.ok) return null;
      const blobUrl = URL.createObjectURL(await resp.blob());
      imgBlobCache.set(url, blobUrl);
      return blobUrl;
    } catch { return null; }
  }

  async function fetchSequential(urls, signal) {
    for (const url of urls) {
      const blob = await fetchAsBlob(url, signal);
      if (blob) return blob;
    }
    return null;
  }

  function getAuth() {
    try {
      const raw = localStorage.getItem('jellyfin_credentials');
      if (!raw) return null;
      const creds = JSON.parse(raw);
      const servers = Array.isArray(creds?.Servers) ? creds.Servers : [];
      const currentOrigin = window.location.origin;
      const getOrigin = (value) => {
        if (!value) return null;
        try { return new URL(value, currentOrigin).origin; }
        catch { return null; }
      };
      const serverMatchesCurrentHost = (server) => [
        server.ManualAddress,
        server.LocalAddress,
        server.RemoteAddress,
        server.Address,
        server.Url,
        server.ServerUrl
      ].some(address => getOrigin(address) === currentOrigin);
      const server = servers.find(s => s.AccessToken && serverMatchesCurrentHost(s))
        || servers.find(s => s.AccessToken)
        || servers[0];
      if (server?.AccessToken) return { token: server.AccessToken, userId: server.UserId || '' };
    } catch (err) { console.warn('[PauseScreen] Auth read error:', err); }
    return null;
  }

  function cycleBackdrop(expectedItemId) {
    if (maxBackdropIndex === 1) return;
    clearTimeout(backdropCycleTimer);
    backdropCycleTimer = setTimeout(async () => {
      if (currentItemId !== expectedItemId || !isOverlayVisible) return;
      let nextIndex = activeBackdropIndex + 1;
      if (maxBackdropIndex !== null && nextIndex >= maxBackdropIndex) nextIndex = 0;
      const tagQuery = backdropTags[nextIndex] ? `?tag=${backdropTags[nextIndex]}` : '';
      let nextUrl = `/Items/${activeBackdropItemId}/Images/Backdrop/${nextIndex}${tagQuery}`;
      let nextBlob = await fetchAsBlob(nextUrl);
      if (currentItemId !== expectedItemId || !isOverlayVisible) return;
      if (!nextBlob) {
        maxBackdropIndex = nextIndex;
        if (maxBackdropIndex <= 1) return;
        nextIndex = 0;
        const fallbackTagQuery = backdropTags[nextIndex] ? `?tag=${backdropTags[nextIndex]}` : '';
        nextUrl = `/Items/${activeBackdropItemId}/Images/Backdrop/${nextIndex}${fallbackTagQuery}`;
        nextBlob = await fetchAsBlob(nextUrl);
        if (!nextBlob) { maxBackdropIndex = 1; return; }
      }
      fgBackdropEl.style.transition = 'none';
      fgBackdropEl.style.backgroundImage = `url('${nextBlob}')`;
      if (isFallbackPrimary) fgBackdropEl.classList.add('ps-blurred'); else fgBackdropEl.classList.remove('ps-blurred');
      void fgBackdropEl.offsetWidth;
      fgBackdropEl.style.transition = `opacity ${CONFIG.backdropFadeMs}ms ease`;
      fgBackdropEl.style.opacity = '1';
      directorRequest('extractColor', { blobUrl: nextBlob }).then(c => { if (currentItemId === expectedItemId) applyThemeColor(overlay, c); }).catch(()=>{});
      
      if (isFallbackPrimary && CONFIG.preBlurSize > 0) {
          directorRequest('preBlur', { blobUrl: nextBlob, size: CONFIG.preBlurSize, passes: CONFIG.preBlurPasses || 3, blurRadius: CONFIG.preBlurRadius || 20 })
            .then(res => {
              if (currentItemId === expectedItemId && res?.blurredBlob) {
                const blurUrl = URL.createObjectURL(res.blurredBlob);
                imgBlobCache.set(nextBlob + '_blur', blurUrl);
                fgBackdropEl.style.backgroundImage = `url('${blurUrl}')`;
                fgBackdropEl.classList.remove('ps-blurred');
              }
            }).catch(() => {});
      }

      setTimeout(() => {
        if (currentItemId !== expectedItemId) return;
        bgBackdropEl.style.backgroundImage = `url('${nextBlob}')`;
        if (isFallbackPrimary) {
           if (imgBlobCache.has(nextBlob + '_blur')) {
               bgBackdropEl.style.backgroundImage = `url('${imgBlobCache.get(nextBlob + '_blur')}')`;
               bgBackdropEl.classList.remove('ps-blurred');
           } else {
               bgBackdropEl.classList.add('ps-blurred');
           }
        } else {
           bgBackdropEl.classList.remove('ps-blurred');
        }
        setTimeout(() => {
          if (currentItemId !== expectedItemId) return;
          fgBackdropEl.style.transition = 'none';
          fgBackdropEl.style.opacity = '0';
          activeBackdropIndex = nextIndex;
          if (isOverlayVisible) cycleBackdrop(expectedItemId);
        }, 150);
      }, CONFIG.backdropFadeMs + 50);
    }, CONFIG.backdropCycleRestMs);
  }

  async function fetchAndApplyMetadata(itemId, auth) {
    if (itemId === renderedItemId || itemId === currentItemId) return true;
    if (fetchAbort) { fetchAbort.abort(); fetchAbort = null; }
    currentItemId = itemId; fetchAbort = new AbortController(); resetDOMContent();
    const signal = fetchAbort.signal;
    authHeaders = { 'Authorization': `MediaBrowser Token="${auth.token}"` };
    let data;
    if (itemCache.has(itemId)) { data = itemCache.get(itemId); }
    else {
      try {
        const resp = await fetch(`/Items/${itemId}`, { signal: fetchAbort.signal, headers: authHeaders });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const jsonText = await resp.text();
        data = await directorRequest('parseMetadata', { jsonText }, fetchAbort.signal);
        
        const validTypes = ['Movie', 'Episode', 'Video', 'MusicVideo', 'TvChannel', 'Program', 'Trailer', 'Audio'];
        if (!validTypes.includes(data.Type)) {
          console.warn(`[PauseScreen] Invalid metadata type: ${data.Type}`);
          resetFetchState();
          return false;
        }
        
        itemCache.set(itemId, data);
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error('[PauseScreen] Metadata fetch failed:', err);
          if (currentItemId === itemId) resetFetchState();
        }
        return false;
      }
    }
    
    const validTypes = ['Movie', 'Episode', 'Video', 'MusicVideo', 'TvChannel', 'Program', 'Trailer', 'Audio'];
    if (data && !validTypes.includes(data.Type)) {
      resetFetchState();
      return false;
    }
    
    if (currentItemId !== itemId) return false;
    originalTextHTML = sanitizeHTML(data.Overview || '');
    const isEpisode = data.Type === 'Episode', seriesId = data.SeriesId || null, parentId = data.ParentId || null;
    titleEl.textContent = isEpisode ? (data.SeriesName || data.Name) : data.Name;
    titleEl.style.setProperty('display', 'block', 'important');
    if (isEpisode && data.Name) { 
      episodeEl.textContent = `S${String(data.ParentIndexNumber).padStart(2, '0')} · E${String(data.IndexNumber).padStart(2, '0')} — ${data.Name}`; 
      episodeEl.style.setProperty('display', 'block', 'important'); 
    }
    metaYear.textContent = data.ProductionYear || ''; 
    metaRating.textContent = data.OfficialRating || ''; 
    metaRating.style.display = data.OfficialRating ? 'inline' : 'none';
    metaGenres.textContent = data.Genres?.slice(0, (isPhonePortrait() ? CONFIG.genresMaxPhonePortrait : CONFIG.genresMaxDefault)).join(' · ') || ''; 
    metaStar.textContent = data.CommunityRating ? `★ ${data.CommunityRating.toFixed(1)}` : '';
    if (data.RunTimeTicks) { 
      const totalMins = Math.floor(data.RunTimeTicks / 600000000); 
      const h = Math.floor(totalMins / 60);
      metaRuntime.textContent = h > 0 ? `${h}h ${totalMins % 60}m` : `${totalMins}m`; 
    } else { 
      metaRuntime.textContent = ''; 
    }
    synopsisEl.innerHTML = originalTextHTML;
    renderedItemId = itemId;
    adjustLayout();
    renderChapterTicks(data.Chapters, data.RunTimeTicks);

    const backdropPromise = (async () => {
      activeBackdropItemId = data.Id;
      maxBackdropIndex = data.BackdropImageTags?.length || 0;
      backdropTags = data.BackdropImageTags || [];
      isFallbackPrimary = false;
      if (maxBackdropIndex === 0) {
        if (data.ParentBackdropImageTags?.length > 0) {
          activeBackdropItemId = data.ParentBackdropItemId;
          maxBackdropIndex = data.ParentBackdropImageTags.length;
          backdropTags = data.ParentBackdropImageTags;
        } else if (seriesId) { activeBackdropItemId = seriesId; maxBackdropIndex = null; }
        else if (parentId) { activeBackdropItemId = parentId; maxBackdropIndex = null; }
      }
      let firstBackdropBlob = null;
      activeBackdropIndex = 0;
      if (activeBackdropItemId) {
        const tagQuery = backdropTags[0] ? `?tag=${backdropTags[0]}` : '';
        firstBackdropBlob = await fetchAsBlob(`/Items/${activeBackdropItemId}/Images/Backdrop/0${tagQuery}`, signal);
      }
      if (!firstBackdropBlob) {
        maxBackdropIndex = 1;
        const fallbacks = [`/Items/${itemId}/Images/Thumb`, ...(parentId ? [`/Items/${parentId}/Images/Thumb`] : []), `/Items/${itemId}/Images/Primary`, ...(parentId ? [`/Items/${parentId}/Images/Primary`] : [])];
        for (let f of fallbacks) {
          const b = await fetchAsBlob(f, signal);
          if (b) { firstBackdropBlob = b; if (f.includes('/Primary') && !isEpisode) isFallbackPrimary = true; break; }
        }
      }
      if (currentItemId !== itemId) return;
      if (firstBackdropBlob) {
        bgBackdropEl.style.backgroundImage = `url('${firstBackdropBlob}')`;
        if (isFallbackPrimary) { bgBackdropEl.classList.add('ps-blurred'); fgBackdropEl.classList.add('ps-blurred'); }
        else { bgBackdropEl.classList.remove('ps-blurred'); fgBackdropEl.classList.remove('ps-blurred'); }
        directorRequest('extractColor', { blobUrl: firstBackdropBlob }, signal)
          .then(c => { if (currentItemId === itemId) applyThemeColor(overlay, c); })
          .catch(() => {});

        if (isFallbackPrimary && CONFIG.preBlurSize > 0) {
          directorRequest('preBlur', { blobUrl: firstBackdropBlob, size: CONFIG.preBlurSize, passes: CONFIG.preBlurPasses || 3, blurRadius: CONFIG.preBlurRadius || 20 }, signal)
            .then(res => {
              if (currentItemId === itemId && res?.blurredBlob) {
                const blurUrl = URL.createObjectURL(res.blurredBlob);
                imgBlobCache.set(firstBackdropBlob + '_blur', blurUrl);
                bgBackdropEl.style.backgroundImage = `url('${blurUrl}')`;
                bgBackdropEl.classList.remove('ps-blurred');
              }
            }).catch(() => {});
        }

        if (isOverlayVisible && (maxBackdropIndex === null || maxBackdropIndex > 1)) cycleBackdrop(itemId);
      } else { bgBackdropEl.style.backgroundImage = 'none'; applyThemeColor(overlay, null); }
    })();

    const logoPromise = (async () => {
      const logoUrls = [...(seriesId ? [`/Items/${seriesId}/Images/Logo`] : []), ...(parentId ? [`/Items/${parentId}/Images/Logo`] : []), `/Items/${itemId}/Images/Logo`];
      const logoBlob = await fetchSequential(logoUrls, signal);
      if (currentItemId !== itemId || !logoBlob) return;
      logoEl.src = logoBlob;
      logoEl.style.setProperty('display', 'block', 'important');
      titleEl.style.display = 'none';
      adjustLayout();
      directorRequest('autocrop', { 
        blobUrl: logoBlob, 
        step: CONFIG.logoCropScanStep || 2,
        alphaThreshold: CONFIG.logoCropAlphaThreshold !== undefined ? CONFIG.logoCropAlphaThreshold : 10,
        pad: CONFIG.logoCropPaddingPx !== undefined ? CONFIG.logoCropPaddingPx : 10
      }, signal).then(res => {
        if (currentItemId !== itemId || !res || !res.croppedBlob) return;
        const croppedUrl = URL.createObjectURL(res.croppedBlob);
        if (currentCroppedLogoUrl && currentCroppedLogoUrl !== logoBlob) {
          URL.revokeObjectURL(currentCroppedLogoUrl);
        }
        currentCroppedLogoUrl = croppedUrl;
        logoEl.src = croppedUrl;
        adjustLayout();
      }).catch(()=>{});
    })();

    const discPromise = (async () => {
      const discUrls = data.Type === 'Movie' ? [`/Items/${itemId}/Images/Disc`, ...(parentId ? [`/Items/${parentId}/Images/Disc`] : [])] : [];
      const discBlob = await fetchSequential(discUrls, signal);
      if (currentItemId !== itemId) return;
      const hasDisc = !!discBlob;
      const showDisc = hasDisc && !isPortrait();
      discEl.dataset.hasDisc = String(hasDisc);
      discEl.style.display = 'none';
      if (hasDisc) {
        discEl.src = discBlob;
        if (showDisc) discEl.style.display = 'block';
        rightCol.classList.remove('ps-no-disc');
      } else {
        discEl.src = '';
        rightCol.classList.add('ps-no-disc');
      }
    })();

    // Let image assets load in the background — overlay shows text immediately
    Promise.all([backdropPromise, logoPromise, discPromise]);
    
    return true;
  }

  function handleDismissTouch() {
    if (!isDismissed) return;
    clearTimeout(dismissTimer);
    dismissTimer = setTimeout(restoreFromDismiss, CONFIG.touchDismissRestoreMs);
  }

  function triggerDismiss(e) {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    if (isDismissed) return;
    isDismissed = true;
    overlay.style.setProperty('opacity', '0', 'important');
    overlay.style.pointerEvents = 'none';
    document.addEventListener('touchstart', handleDismissTouch, { passive: true });
    handleDismissTouch();
  }

  function restoreFromDismiss() {
    isDismissed = false;
    document.removeEventListener('touchstart', handleDismissTouch);
    if (video && video.paused) {
      overlay.style.setProperty('opacity', '1', 'important');
      overlay.style.pointerEvents = 'auto';
    }
  }

  function showOverlay() {
    if (isOverlayVisible) return;
    isOverlayVisible = true;
    const auth = getAuth();
    const freshId = getItemId(video);
    
    if (auth && freshId) {
      fetchAndApplyMetadata(freshId, auth).catch(err => {
        if (err.name !== 'AbortError') console.error('[PauseScreen] Overlay fetch failed:', err);
      });
    }
    
    // Set up transparent overlay to block interaction while fetching
    isDismissed = false; clearTimeout(dismissTimer);
    document.removeEventListener('touchstart', handleDismissTouch);
    overlay.style.setProperty('display', 'block', 'important'); 
    overlay.style.setProperty('opacity', '0', 'important'); 
    overlay.style.visibility = 'hidden';
    overlay.style.pointerEvents = 'auto';

    updateProgress();
    
    if ((maxBackdropIndex === null || maxBackdropIndex > 1) && !backdropCycleTimer) cycleBackdrop(currentItemId);
    
    requestAnimationFrame(() => { 
      adjustLayout(); 
      requestAnimationFrame(() => { 
        overlay.style.visibility = 'visible'; 
        void overlay.offsetHeight; 
        overlay.style.setProperty('opacity', '1', 'important'); 
      }); 
    });
    
    enableTouchResume();
    resetIdleTimer();
  }

  function hideOverlay() {
    if (!isOverlayVisible) return;
    isOverlayVisible = false;
    exitScreensaver();
    clearTimeout(idleTimer); idleTimer = null;
    stopScrollAnimation();
    overlay.style.setProperty('opacity', '0', 'important');
    clearTimeout(mouseTimer); clearTimeout(touchReadyTimer); touchResumeReady = false;
    clearTimeout(backdropCycleTimer); backdropCycleTimer = null;
    isDismissed = false; clearTimeout(dismissTimer); document.removeEventListener('touchstart', handleDismissTouch);
    setTimeout(() => { if (!isOverlayVisible) overlay.style.setProperty('display', 'none', 'important'); }, 350);
  }

  let lastPointerX = -1;
  let lastPointerY = -1;

  function triggerActivityHide({ ignoreOsdHover = false } = {}) {
    hideOverlay();
    clearTimeout(mouseTimer);
    
    function attemptShow() {
      // If no longer paused or bound, stop retrying
      if (!video || !video.paused) return;

      // Prevent showing if a native dialog or menu is actively open
      const blockingElements = ['.dialogContainer', '.actionSheet', '.upNextDialog', '.playerStats-content'];
      const isBlockingElementOpen = blockingElements.some(sel => {
         const el = document.querySelector(sel);
         // More robust visibility check
         return el && (el.offsetWidth > 0 || el.offsetHeight > 0);
      });

      if (isBlockingElementOpen) {
        mouseTimer = setTimeout(attemptShow, 500); 
        return;
      }

      // Check if native OSD is hovered (mouse is over controls)
      const osdHovered = document.querySelector('.videoOsdBottom:hover, .osdControls:hover, .header-player:hover');
      if (osdHovered && !ignoreOsdHover) {
        mouseTimer = setTimeout(attemptShow, 500);
        return;
      }

      showOverlay();
    }

    mouseTimer = setTimeout(attemptShow, CONFIG.mouseShowDelay);
  }

  function onPointerMove(e) {
    if (e.pointerType === 'touch' || !video || !video.paused || video.currentTime === 0) return;

    // Prevent micro-jitter from waking/hiding the screen constantly
    if (lastPointerX !== -1) {
      const deltaX = Math.abs(e.clientX - lastPointerX);
      const deltaY = Math.abs(e.clientY - lastPointerY);
      if (deltaX < 3 && deltaY < 3) return;
    }
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;

    // Wake screensaver on any real mouse movement
    if (isScreensaver) {
      triggerActivityHide({ ignoreOsdHover: true });
      return;
    }
    resetIdleTimer();

    if (Date.now() - lastPauseTime < CONFIG.mouseHideDelay) return;
    triggerActivityHide();
  }

  function onWheel(e) {
    if (!video || !video.paused || video.currentTime === 0) return;
    
    if (e.target.closest('.ps-synopsis')) {
      // Manual scroll: keep internal Y synced and pause auto-scroll
      isUserScrolling = true;
      clearTimeout(userScrollTimeout);
      userScrollTimeout = setTimeout(() => {
        currentScrollY = synopsisEl.scrollTop;
        isUserScrolling = false;
        manualScrollEndTime = performance.now();
      }, 150);
      return; // Do not hide overlay, let the wheel event scroll the container
    }
    
    triggerActivityHide();
  }

  function enableTouchResume() { clearTimeout(touchReadyTimer); touchResumeReady = false; touchReadyTimer = setTimeout(() => { touchResumeReady = true; }, CONFIG.touchResumeDelayMs); }

  function resetFetchState() { if (fetchAbort) { fetchAbort.abort(); fetchAbort = null; } clearTimeout(prefetchRetryTimer); prefetchRetryTimer = null; clearTimeout(pauseShowTimer); pauseShowTimer = null; currentItemId = null; renderedItemId = null; lastPauseTime = 0; activeBackdropItemId = null; maxBackdropIndex = null; authHeaders = {}; activeBackdropIndex = 0; clearTimeout(backdropCycleTimer); backdropCycleTimer = null; isFallbackPrimary = false; backdropTags = []; }
  
  function resetDOMContent() {
    if (currentCroppedLogoUrl) {
      URL.revokeObjectURL(currentCroppedLogoUrl);
      currentCroppedLogoUrl = null;
    }
    bgBackdropEl.style.backgroundImage = '';
    fgBackdropEl.style.backgroundImage = '';
    fgBackdropEl.style.transition = 'none';
    fgBackdropEl.style.opacity = '0';
    bgBackdropEl.classList.remove('ps-blurred');
    fgBackdropEl.classList.remove('ps-blurred');
    logoEl.style.display = 'none'; logoEl.src = '';
    titleEl.style.display = 'none'; titleEl.textContent = '';
    episodeEl.style.display = 'none'; episodeEl.textContent = '';
    metaYear.textContent = ''; metaRating.textContent = ''; metaRating.style.display = 'none';
    metaRuntime.textContent = ''; metaGenres.textContent = ''; metaStar.textContent = '';
    synopsisEl.textContent = ''; synopsisEl.style.fontSize = ''; synopsisEl.style.maxHeight = 'none';
    synopsisEl.style.maskImage = 'none'; synopsisEl.style.webkitMaskImage = 'none';
    originalTextHTML = '';
    discEl.style.display = 'none'; discEl.src = ''; discEl.dataset.hasDisc = 'false';
    rightCol.classList.remove('ps-no-disc');
    chapterTicksEl.innerHTML = '';
    chapterTicksData = [];
    progressFill.style.width = '0%'; progressTime.textContent = ''; progressPct.textContent = ''; progressEnd.textContent = '';
    applyThemeColor(overlay, null);
  }

  function resetOverlayState() { stopScrollAnimation(); detachScrollDOM(); clearTimeout(mouseTimer); clearTimeout(touchReadyTimer); touchResumeReady = false; isOverlayVisible = false; isDismissed = false; overlay.style.setProperty('display', 'none', 'important'); overlay.style.setProperty('opacity', '0', 'important'); }
  function purge() { resetFetchState(); resetDOMContent(); resetOverlayState(); }

  // --- CHAPTER TICKS ---
  function renderChapterTicks(chapters, runTimeTicks) {
    chapterTicksEl.innerHTML = '';
    chapterTicksData = [];
    if (!chapters || !chapters.length || !runTimeTicks) return;
    const frag = document.createDocumentFragment();
    for (const ch of chapters) {
      if (!ch.StartPositionTicks || ch.StartPositionTicks <= 0 || ch.StartPositionTicks >= runTimeTicks) continue;
      const pct = (ch.StartPositionTicks / runTimeTicks) * 100;
      const tick = document.createElement('div');
      tick.className = 'ps-chapter-tick';
      tick.style.left = `${pct}%`;
      frag.appendChild(tick);
      chapterTicksData.push({ el: tick, pct });
    }
    chapterTicksEl.appendChild(frag);
  }

  function updateProgress() {
    if (!video) return;
    const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const duration = video.duration;
    const hasFiniteDuration = Number.isFinite(duration) && duration > 0;
    const pct = hasFiniteDuration ? (current / duration) * 100 : 0;
    progressFill.style.width = `${pct}%`;
    progressTime.textContent = hasFiniteDuration ? `${formatClock(current)} / ${formatClock(duration)}` : formatClock(current);
    progressPct.textContent = hasFiniteDuration ? `${Math.round(pct)}% watched` : (duration === Infinity ? 'Live' : 'Duration unavailable');
    progressEnd.textContent = hasFiniteDuration ? `Ends at ${new Date(Date.now() + (duration - current) * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';

    for (let i = 0; i < chapterTicksData.length; i++) {
      if (pct >= chapterTicksData[i].pct) {
        chapterTicksData[i].el.classList.add('ps-past');
      } else {
        chapterTicksData[i].el.classList.remove('ps-past');
      }
    }
  }

  // --- IDLE SCREENSAVER ---
  function bounceLogo() {
    const speedFull = CONFIG.idleLogoSpeedPx || 80;
    const rampMs = CONFIG.idleLogoRampMs || 5000;
    const scaleMax = CONFIG.idleLogoScaleMax || 1.5;
    const scaleRampMs = CONFIG.idleLogoScaleRampMs || 30000;

    let lastTs = performance.now();
    function frame(now) {
      if (!isScreensaver) return;
      // clamp dt to avoid huge jumps if browser backgrounded
      const dt = Math.min((now - lastTs) / 1000, 0.1); 
      lastTs = now;

      const elapsed = performance.now() - ssStartTime;

      // Smooth scale ramp (easeOutQuad)
      const scaleT = Math.min(elapsed / scaleRampMs, 1);
      const currentScale = 1 + (scaleMax - 1) * (scaleT * (2 - scaleT));

      // Calculate bounds dynamically every frame so it instantly adapts to viewport resizes
      const W = window.innerWidth, H = window.innerHeight;
      const baseLogoW = screensaverLogoEl.offsetWidth || 200;
      const baseLogoH = screensaverLogoEl.offsetHeight || 80;
      
      const scaledW = baseLogoW * currentScale;
      const scaledH = baseLogoH * currentScale;
      
      const maxX = Math.max(0, W - scaledW);
      const maxY = Math.max(0, H - scaledH);

      // Smooth sine ease-in: avoids completely stationary start, builds nicely
      const t = Math.min(elapsed / rampMs, 1);
      const speedMultiplier = 1 - Math.cos((t * Math.PI) / 2); // easeInSine
      const speed = speedFull * Math.max(0.05, speedMultiplier); // 5% floor ensures it always moves slightly

      ssLogoX += ssVelX * speed * dt;
      ssLogoY += ssVelY * speed * dt;

      if (ssLogoX <= 0) { ssLogoX = 0; ssVelX = Math.abs(ssVelX); }
      if (ssLogoX >= maxX) { ssLogoX = maxX; ssVelX = -Math.abs(ssVelX); }
      if (ssLogoY <= 0) { ssLogoY = 0; ssVelY = Math.abs(ssVelY); }
      if (ssLogoY >= maxY) { ssLogoY = maxY; ssVelY = -Math.abs(ssVelY); }

      // Use translate3d for sub-pixel GPU smoothness (bypasses integer pixel snapping)
      screensaverLogoEl.style.transform = `translate3d(${ssLogoX}px, ${ssLogoY}px, 0) scale(${currentScale})`;
      ssRaf = requestAnimationFrame(frame);
    }
    ssRaf = requestAnimationFrame(frame);
  }

  function enterScreensaver() {
    if (isScreensaver || !isOverlayVisible) return;
    isScreensaver = true;
    stopScrollAnimation();

    // Sync screensaver logo with current logo src
    const logoSrc = logoEl.src || '';
    if (!logoSrc) {
      resetIdleTimer();
      return;
    }

    screensaverLogoEl.src = logoSrc;

    // Start from the logo's current on-screen position (no jump)
    const logoRect = logoEl.getBoundingClientRect();
    ssLogoX = logoRect.left;
    ssLogoY = logoRect.top;
    
    // Lock dimensions to the exact pixel size of the original logo at start time.
    // This ensures the base size remains perfectly constant (and scaling is smooth) 
    // even if CSS media queries try to alter it during an orientation change.
    screensaverLogoEl.style.width = `${logoRect.width}px`;
    screensaverLogoEl.style.height = `${logoRect.height}px`;
    screensaverLogoEl.style.transformOrigin = 'top left'; // ensures scale() expands downwards/rightwards logically
    screensaverLogoEl.style.transform = `translate3d(${ssLogoX}px, ${ssLogoY}px, 0) scale(1)`;
    screensaverLogoEl.style.opacity = '1'; // immediately visible at its original spot

    const angle = Math.random() * Math.PI * 2;
    ssVelX = Math.cos(angle); ssVelY = Math.sin(angle);
    ssStartTime = performance.now();

    overlay.classList.add('ps-screensaver');
    bounceLogo();
  }

  function exitScreensaver() {
    if (!isScreensaver) return;
    isScreensaver = false;
    cancelAnimationFrame(ssRaf); ssRaf = null;
    overlay.classList.remove('ps-screensaver');
    screensaverLogoEl.style.opacity = '0';
    screensaverLogoEl.src = '';
    ssLogoX = 0; ssLogoY = 0;
    resetIdleTimer();
  }

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    if (!isOverlayVisible) return;
    const ms = CONFIG.idleAutoDismissMs || 600000;
    idleTimer = setTimeout(enterScreensaver, ms);
  }

  let globalTouchStartX = 0, globalTouchStartY = 0;

  function onGlobalTouchStart(e) {
    globalTouchStartX = e.touches[0].clientX;
    globalTouchStartY = e.touches[0].clientY;
    // Wake screensaver on touch
    if (isScreensaver) { exitScreensaver(); return; }
    resetIdleTimer();
  }

  function onGlobalScreenTap(e) {
    if (!video) return;

    // 1. Safe zones: every overlay window in Jellyfin (native + plugin)
    // Covers: dialogHelper modals, action sheets, Up Next, Skip buttons,
    // playback stats, subtitle sync, SyncPlay, chapter previews, slider bubbles
    const safeZones = [
      // Custom pause badge
      '.ps-paused-badge',
      // dialogHelper system (settings, audio/subtitle pickers, all plugin dialogs)
      '.dialogBackdrop', '.dialogContainer', '.dialog',
      // Action sheets (subtitle/audio track selection, settings menu)
      '.actionSheet',
      // Up Next auto-play dialog
      '.upNextDialog', '.upNextContainer',
      // Skip Intro / Skip Outro / Skip Credits buttons
      '.skip-button-container', '.skip-button',
      // Playback stats overlay ("Stats for Nerds")
      '.playerStats-content',
      // Subtitle sync offset slider
      '.subtitleSync', '.subtitleSyncContainer',
      // SyncPlay group watch indicator
      '.syncPlayContainer',
      // Chapter/trickplay preview on scrub
      '.chapterThumbContainer',
      // Slider tooltip bubbles (volume, position)
      '.sliderBubble',
      // In-player episode/collection preview list
      '.in-player-preview',
      // Generic catch-all for unknown plugin overlays
      '.modal-container'
    ];
    if (safeZones.some(sel => e.target.closest(sel))) {
      return;
    }

    // 2. Do not toggle if the user tapped directly on OSD controls
    const osdTargets = [
      '.ps-close-btn', '.videoOsdBottom', '.osdHeader', '.osdControls',
      '.header-player', '.btnBack', '.btnSubtitles', '.btnSettings',
      '.btnPip', '.btnCast', '.btnInfo', '.btnAudio', '.btnFullscreen',
      '.btnVideoOsdSettings', '.btnRecord', '.btnUserRating',
      '.btnPreviousTrack', '.btnNextTrack', '.btnPreviousChapter', '.btnNextChapter',
      '.osdTextContainer', '.osdPositionSlider', '.osdVolumeSlider'
    ];
    if (osdTargets.some(sel => e.target.closest(sel))) return;

    // 3. When dismissed (pause screen on, and pressed x), limit play toggle to top 70%
    if (isDismissed) {
      const touchY = e.changedTouches[0].clientY;
      if (touchY > window.innerHeight * 0.70) {
        return; // Bottom 30% is a safe zone when dismissed
      }
    }

    const touchMoveX = Math.abs(e.changedTouches[0].clientX - globalTouchStartX), touchMoveY = Math.abs(e.changedTouches[0].clientY - globalTouchStartY);
    if (touchMoveX > CONFIG.dragThresholdPx || touchMoveY > CONFIG.dragThresholdPx) return;
    if (isOverlayVisible) { if (touchResumeReady) { hideOverlay(); video.play().catch(() => { }); } return; }
    if (!video.paused) { video.pause(); return; }
  }

  function onPause() {
    if (!hasStartedPlaying) return; // Ignore pause events during initial load
    if (video && video.currentTime === 0) return; // Prevent flashing during auto-play initialization

    lastPauseTime = Date.now(); globalPauseTime = performance.now();
    clearTimeout(pauseShowTimer);
    const delay = CONFIG.pauseShowDelayTouchMs || 0;
    if (delay > 0) { pauseShowTimer = setTimeout(() => { if (video?.paused) showOverlay(); }, delay); } else { showOverlay(); }
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('wheel', onWheel, { passive: true });
  }

  function onPlay() {
    hasStartedPlaying = true;
    clearTimeout(pauseShowTimer); pauseShowTimer = null;
    hideOverlay(); clearTimeout(mouseTimer);
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('wheel', onWheel);
  }
  function onEnded() { purge(); onPlay(); }
  function onSeeked() { if (isOverlayVisible && video && video.paused) updateProgress(); }


  function onDocumentKeyDown(e) {
    if (e.key === 'Escape' && video) {
      const closeBtn = document.querySelector('.headerBackButton, .btnHeaderBack, .btn-back, [data-action="back"]');
      if (closeBtn) closeBtn.click();
    }

    // Wake from screensaver on any key
    if (isScreensaver) { exitScreensaver(); return; }

    // Arrow keys: seek ±N seconds and dismiss overlay
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && video && video.paused && video.currentTime !== 0) {
      e.preventDefault();
      const secs = CONFIG.keyboardSeekSeconds || 10;
      video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + (e.key === 'ArrowRight' ? secs : -secs)));
      triggerActivityHide();
      return;
    }

    // Any other action key hides the overlay
    if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key) && video && video.paused && video.currentTime !== 0) {
      triggerActivityHide();
    }
  }

  let handleLoadedMetadata = null;

  function bindVideo(el) {
    if (video === el) return; unbindVideo(); video = el; purge();
    hasStartedPlaying = !el.paused; // Recognize already-playing video
    
    handleLoadedMetadata = () => {
      purge(); 
      const auth = getAuth(); 
      if (!auth) return; 
      let attempts = 0; 
      const maxAttempts = 10;
      function tryFetch() { 
        const id = getItemId(el); 
        if (id) { 
          fetchAndApplyMetadata(id, auth).then((isValid) => {
            if (isValid === false && ++attempts < maxAttempts) {
              prefetchRetryTimer = setTimeout(tryFetch, 500);
            }
          }).catch(() => {}); 
        } else if (++attempts < maxAttempts) { 
          prefetchRetryTimer = setTimeout(tryFetch, 250); 
        } 
      }
      prefetchRetryTimer = setTimeout(tryFetch, CONFIG.prefetchDelayMs || 1000);
    };

    el.addEventListener('loadstart', purge); 
    el.addEventListener('emptied', purge); 
    el.addEventListener('ended', onEnded); 
    el.addEventListener('pause', onPause); 
    el.addEventListener('play', onPlay); 
    el.addEventListener('seeked', onSeeked);
    el.addEventListener('loadedmetadata', handleLoadedMetadata);
    document.addEventListener('touchstart', onGlobalTouchStart, { passive: true });
    document.addEventListener('touchend', onGlobalScreenTap, { passive: false });
    document.addEventListener('keydown', onDocumentKeyDown);
    
    if (el.readyState >= 1) handleLoadedMetadata();
    
    if (el.paused && hasStartedPlaying) onPause();
  }

  function unbindVideo() {
    if (!video) return;
    video.removeEventListener('loadstart', purge); 
    video.removeEventListener('emptied', purge); 
    video.removeEventListener('ended', onEnded); 
    video.removeEventListener('pause', onPause); 
    video.removeEventListener('play', onPlay); 
    video.removeEventListener('seeked', onSeeked);
    if (handleLoadedMetadata) {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      handleLoadedMetadata = null;
    }
    document.removeEventListener('touchstart', onGlobalTouchStart);
    document.removeEventListener('touchend', onGlobalScreenTap);
    document.removeEventListener('keydown', onDocumentKeyDown);
    video = null;
  }

  function onOverlayTouchStart(e) { 
    touchStartX = e.touches[0].clientX; 
    touchStartY = e.touches[0].clientY; 
    isFingerDown = true; 
    isUserScrolling = true;
    clearTimeout(userScrollTimeout);
  }

  function onOverlayTouchEnd(e) {
    isFingerDown = false;

    // ── X BUTTON: dismiss only, never play ──
    if (e.target.closest('.ps-close-btn')) {
      clearTimeout(userScrollTimeout);
      currentScrollY = synopsisEl.scrollTop;
      isUserScrolling = false;
      e.preventDefault(); e.stopPropagation();
      triggerDismiss();
      return;
    }

    // ── SYNOPSIS AREA: allow scrolling, never play ──
    if (e.target.closest('.ps-synopsis')) {
      // Finger lifted inside synopsis — let inertia run, don't play
      e.preventDefault(); e.stopPropagation();
      clearTimeout(userScrollTimeout);
      userScrollTimeout = setTimeout(() => {
        currentScrollY = synopsisEl.scrollTop;
        isUserScrolling = false;
        manualScrollEndTime = performance.now();
      }, 2000);
      return;
    }

    // ── INTERACTIVE ELEMENTS & MODALS: never play ──
    const noPlayZones = [
      // Our own UI elements
      '.ps-meta', '.ps-progress-wrap', '.ps-divider', '.ps-paused-badge',
      // OSD controls
      '.videoOsdBottom', '.osdHeader', '.osdControls', '.header-player',
      // dialogHelper system
      '.dialogBackdrop', '.dialogContainer', '.dialog', '.actionSheet',
      // Up Next / Skip
      '.upNextDialog', '.upNextContainer',
      '.skip-button-container', '.skip-button',
      // Playback stats, subtitle sync, SyncPlay
      '.playerStats-content', '.subtitleSync', '.subtitleSyncContainer',
      '.syncPlayContainer',
      // Chapter preview, slider bubbles, episode preview
      '.chapterThumbContainer', '.sliderBubble', '.in-player-preview',
      // Generic catch-all
      '.modal-container'
    ];
    if (noPlayZones.some(sel => e.target.closest(sel))) {
      e.preventDefault(); e.stopPropagation();
      clearTimeout(userScrollTimeout);
      currentScrollY = synopsisEl.scrollTop;
      isUserScrolling = false;
      return;
    }

    // ── GENERAL OVERLAY TAP: check for drag vs tap ──
    clearTimeout(userScrollTimeout);
    currentScrollY = synopsisEl.scrollTop;
    isUserScrolling = false;

    const touchMoveX = Math.abs(e.changedTouches[0].clientX - touchStartX);
    const touchMoveY = Math.abs(e.changedTouches[0].clientY - touchStartY);
    if (touchMoveX > CONFIG.dragThresholdPx || touchMoveY > CONFIG.dragThresholdPx) return;

    // It was a clean tap on an empty area — resume playback
    if (!touchResumeReady) return; // Guard against accidental immediate taps
    e.preventDefault(); e.stopPropagation();
    video.play().catch(() => { });
  }

  overlay.addEventListener('touchstart', onOverlayTouchStart, { passive: true });
  overlay.addEventListener('touchend', onOverlayTouchEnd, { passive: false });
  overlay.addEventListener('click', (e) => {
    if (e.target.closest('.ps-close-btn')) {
      e.preventDefault(); e.stopPropagation();
      triggerDismiss();
      return;
    }

    // Ignore touch clicks (handled by touchend)
    if (e.pointerType === 'touch') return;

    // Safe zones: elements that shouldn't trigger play/pause
    const noPlayZones = [
      '.ps-meta', '.ps-progress-wrap', '.ps-divider', '.ps-synopsis', '.ps-paused-badge',
      '.videoOsdBottom', '.osdHeader', '.osdControls', '.header-player',
      '.dialogBackdrop', '.dialogContainer', '.dialog', '.actionSheet',
      '.upNextDialog', '.upNextContainer',
      '.skip-button-container', '.skip-button',
      '.playerStats-content', '.subtitleSync', '.subtitleSyncContainer',
      '.syncPlayContainer',
      '.chapterThumbContainer', '.sliderBubble', '.in-player-preview',
      '.modal-container'
    ];
    if (noPlayZones.some(sel => e.target.closest(sel))) return;

    // It was a click on the background — resume playback
    if (video && video.paused) {
      e.preventDefault(); e.stopPropagation();
      hideOverlay();
      video.play().catch(() => { });
    }
  });

  // Inertia-aware scroll sync: keeps currentScrollY in sync with the DOM
  // and detects when momentum scrolling has truly stopped.
  synopsisEl.addEventListener('scroll', () => {
    // Always sync the internal position with reality
    currentScrollY = synopsisEl.scrollTop;

    // If finger is up but we're still getting scroll events, inertia is active.
    // Reset the debounce timer each time — auto-scroll only resumes once
    // no scroll event has fired for 150ms (i.e. momentum has ended).
    if (!isFingerDown && isUserScrolling) {
      clearTimeout(userScrollTimeout);
      userScrollTimeout = setTimeout(() => {
        currentScrollY = synopsisEl.scrollTop;
        isUserScrolling = false;
        manualScrollEndTime = performance.now(); // Triggers the resume ramp
      }, 150);
    }
  }, { passive: true });

  const existingVideo = document.querySelector('.videoPlayerContainer video');
  if (existingVideo) bindVideo(existingVideo);

  function destroy() {
    purge(); unbindVideo(); if (resizeObserver) resizeObserver.disconnect();
    exitScreensaver(); clearTimeout(idleTimer); idleTimer = null;
    clearTimeout(mouseTimer); clearTimeout(touchReadyTimer); clearTimeout(resizeDebounce); clearTimeout(pauseShowTimer); clearTimeout(dismissTimer); clearTimeout(userScrollTimeout);
    document.removeEventListener('pointermove', onPointerMove); document.removeEventListener('touchstart', handleDismissTouch);
    overlay.removeEventListener('touchstart', onOverlayTouchStart); overlay.removeEventListener('touchend', onOverlayTouchEnd);
    if (currentCroppedLogoUrl) URL.revokeObjectURL(currentCroppedLogoUrl);
    imgBlobCache.clear(); itemCache.clear(); overlay.remove();
    const styleTag = document.getElementById('pause-overlay-style');
    if (styleTag) styleTag.remove();
  }

  resizeObserver = new ResizeObserver(() => {
    if (isOverlayVisible && !isAdjusting) { clearTimeout(resizeDebounce); resizeDebounce = setTimeout(adjustLayout, 100); }
  });
  resizeObserver.observe(document.body);

  return { destroy, bindVideo, getVideo: () => video };
}
