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
import { detectPlayerTarget } from '../services/players/detect.js';

const VALID_ITEM_TYPES = new Set(['Movie', 'Episode', 'Video', 'MusicVideo', 'TvChannel', 'Program', 'Trailer', 'Audio']);
const BLOCKING_ELEMENT_SELECTORS = ['.dialogContainer', '.actionSheet', '.upNextDialog', '.playerStats-content'];
const SAFE_ZONE_SELECTORS = [
  '.ps-paused-badge',
  '.dialogBackdrop', '.dialogContainer', '.dialog',
  '.actionSheet',
  '.upNextDialog', '.upNextContainer',
  '.skip-button-container', '.skip-button',
  '.playerStats-content',
  '.subtitleSync', '.subtitleSyncContainer',
  '.syncPlayContainer',
  '.chapterThumbContainer',
  '.sliderBubble',
  '.in-player-preview',
  '.modal-container'
];
const OSD_TARGET_SELECTORS = [
  '.ps-close-btn', '.videoOsdBottom', '.osdHeader', '.osdControls',
  '.header-player', '.btnBack', '.btnSubtitles', '.btnSettings',
  '.btnPip', '.btnCast', '.btnInfo', '.btnAudio', '.btnFullscreen',
  '.btnVideoOsdSettings', '.btnRecord', '.btnUserRating',
  '.btnPreviousTrack', '.btnNextTrack', '.btnPreviousChapter', '.btnNextChapter',
  '.osdTextContainer', '.osdPositionSlider', '.osdVolumeSlider'
];
const OVERLAY_PROTECTED_SELECTORS = [
  '.ps-meta', '.ps-progress-wrap', '.ps-divider', '.ps-paused-badge',
  ...SAFE_ZONE_SELECTORS.filter(selector => selector !== '.ps-paused-badge'),
  ...OSD_TARGET_SELECTORS.filter(selector => selector !== '.ps-close-btn')
];
const CLICK_PROTECTED_SELECTORS = ['.ps-synopsis', ...OVERLAY_PROTECTED_SELECTORS];
const SCREENSAVER_ELEMENTS_FADE_MS = 1500;
const SCREENSAVER_LOGO_DELAY_MS = SCREENSAVER_ELEMENTS_FADE_MS + 500;
// On touch, a tap on the video surface is the gesture that summons Jellyfin's controls —
// and it is also the tap that pauses (ours, or Jellyfin's own handler on the same tap).
// A `pause` landing inside this window after such a tap is treated as tap-initiated, and
// the overlay waits CONFIG.pauseShowDelayTouchMs so the controls get the screen first.
const TAP_PAUSE_WINDOW_MS = 400;

function isInAnyZone(target, selectors) {
  return selectors.some(selector => target.closest(selector));
}

/**
 * B5 / F2 — is the bound target a Route C façade rather than a real HTMLMediaElement?
 *
 * The five "has playback actually begun?" guards below are POLYMORPHIC on this, and that
 * is not a style choice. v4.2.0's first cut replaced all five `currentTime === 0` /
 * `!== 0` sentinels with the `hasStartedPlaying` flag in shared, ungated code, so the
 * change went live on every browser with both flags off — exactly what spec §7 step 2
 * forbids, and it broke two real cases:
 *
 *   - Autoplay blocked: play() fires the `play` event (flag := true), the promise
 *     rejects, the element fires `pause` at position 0. The old sentinel suppressed that;
 *     the flag did not, so a full opaque overlay flashed over the click-to-play state at
 *     0% with no metadata. (The deleted comment read "Prevent flashing during auto-play
 *     initialization" — it was load-bearing.)
 *   - Mid-playback stream change (audio/subtitle/quality switch) fires loadstart on the
 *     SAME element with no fresh `play` to follow; clearing the flag there killed
 *     onPause/onPointerMove/onWheel/keyboard for the rest of that stream.
 *
 * So: on a real <video> the original sentinel is preserved VERBATIM at all five sites,
 * and `hasStartedPlaying` is used only on the façade — where B5 actually applies, because
 * mpv has no meaningful zero position and a resumed item never reports 0.
 */
function isPauseScreenFacade(target) {
  return !!(target && target.__isPauseScreenFacade);
}

export function initPauseScreen(bootObserver) {
  // --- INTERNAL STATE ---
  let video = null, mouseTimer = null, fetchAbort = null;
  let currentItemId = null, renderedItemId = null, prefetchRetryTimer = null, pauseShowTimer = null;
  let resizeObserver = null, resizeDebounce = null, lastPauseTime = 0, globalPauseTime = 0, isAdjusting = false;
  
  const itemCache = makeLRUCache(50);
  const themeColorCache = makeLRUCache(CONFIG.blobCacheMaxSize);
  const imgBlobCache = makeLRUBlobCache(CONFIG.blobCacheMaxSize);
  
  let activeBackdropItemId = null;
  let maxBackdropIndex = null;
  let backdropTags = [];
  let authHeaders = {};
  let activeBackdropIndex = 0;
  let backdropCycleTimer = null;
  let isFallbackPrimary = false;

  let touchStartX = 0, touchStartY = 0, touchResumeReady = false, touchReadyTimer = null, lastScreenTapAt = 0;
  let scrollRAF = null, lastFrameTime = 0;
  let spacerEl = null, cloneEl = null, originalTextHTML = '';
  let isDismissed = false, dismissTimer = null, isOverlayVisible = false;
  let isFingerDown = false, isUserScrolling = false, userScrollTimeout = null;
  let currentScrollY = 0;
  let manualScrollEndTime = 0;
  let hasStartedPlaying = false;
  let forceMouseReturnPending = false;

  // --- IDLE SCREENSAVER STATE ---
  let idleTimer = null, isScreensaver = false;
  let ssLogoX = 0, ssLogoY = 0, ssVelX = 1, ssVelY = 0.7, ssRaf = null, ssStartTime = 0, ssStartTimer = null;
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
    const discRect = discEl.getBoundingClientRect();
    const rightWidth = discRect.width || rightCol.getBoundingClientRect().width || 0;
    const rightHeight = discRect.height || rightWidth;
    
    const landscapeWidthPct = badgeConfig.landscapeWidthPctOfDisc || 40;
    const landscapeHeightPct = badgeConfig.landscapeHeightPctOfDisc || 11.5;
    const landscapeWidth = rightWidth * landscapeWidthPct / 100;
    const landscapeHeight = rightHeight * landscapeHeightPct / 100;
    
    const isPhone = isPhonePortrait();
    const portraitWidthPct = isPhone ? (badgeConfig.portraitPhoneWidthPct || 36) : (badgeConfig.portraitTabletWidthPct || 24);
    const portraitHeightPct = isPhone ? (badgeConfig.portraitPhoneHeightPctOfVW || 10.7) : (badgeConfig.portraitTabletHeightPctOfVW || 7.1);
    
    const portraitWidth = window.innerWidth * portraitWidthPct / 100;
    const portraitHeight = window.innerWidth * portraitHeightPct / 100;

    overlay.style.setProperty('--pause-badge-landscape-width', `${Math.max(0, landscapeWidth)}px`);
    overlay.style.setProperty('--pause-badge-landscape-height', `${Math.max(0, landscapeHeight)}px`);
    overlay.style.setProperty('--pause-badge-portrait-width', `${Math.max(0, portraitWidth)}px`);
    overlay.style.setProperty('--pause-badge-portrait-height', `${Math.max(0, portraitHeight)}px`);
    overlay.style.setProperty('--pause-badge-top', `${badgeConfig.landscapeTopPct || 50}%`);
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

  // Images that get painted full-screen behind the overlay. Logo/Disc are left alone on purpose:
  // they carry alpha, and the worker's crop scans that alpha (CONFIG.logoCropAlphaThreshold).
  const SIZED_IMAGE_TYPES = new Set(['Backdrop', 'Thumb', 'Primary']);

  // Width needed to `cover` the player viewport, quantized so a resize does not churn the blob cache.
  function backdropRequestWidth() {
    const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.backdropMaxDpr || 2);
    const vw = (window.innerWidth || 1920) * dpr;
    const vh = (window.innerHeight || 1080) * dpr;
    // In portrait, height is the binding dimension for `cover`, so a screen-width request is far too small.
    const needed = Math.max(vw, vh * (CONFIG.backdropAspect || 16 / 9));
    const step = CONFIG.backdropQuantizePx || 160;
    const quantized = Math.ceil(needed / step) * step;
    return Math.max(step, Math.min(quantized, CONFIG.backdropMaxWidthPx || 3840));
  }

  function imageUrl(itemId, imageType, index = null, tag = '') {
    const indexPath = index === null ? '' : `/${index}`;
    const params = [];
    if (tag) params.push(`tag=${tag}`);
    if (CONFIG.backdropSizing && SIZED_IMAGE_TYPES.has(imageType)) {
      // maxWidth never upscales, so a small source still costs only what it is.
      params.push(`maxWidth=${backdropRequestWidth()}`);
      if (CONFIG.backdropQuality) params.push(`quality=${CONFIG.backdropQuality}`);
    }
    return `/Items/${itemId}/Images/${imageType}${indexPath}${params.length ? `?${params.join('&')}` : ''}`;
  }

  function getLogoUrls(itemId, seriesId, parentId) {
    return [
      ...(seriesId ? [imageUrl(seriesId, 'Logo')] : []),
      ...(parentId ? [imageUrl(parentId, 'Logo')] : []),
      imageUrl(itemId, 'Logo')
    ];
  }

  function getDiscUrls(data, itemId, parentId) {
    return data.Type === 'Movie' ? [
      imageUrl(itemId, 'Disc'),
      ...(parentId ? [imageUrl(parentId, 'Disc')] : [])
    ] : [];
  }

  function getFallbackBackdropUrls(itemId, parentId) {
    return [
      imageUrl(itemId, 'Thumb'),
      ...(parentId ? [imageUrl(parentId, 'Thumb')] : []),
      imageUrl(itemId, 'Primary'),
      ...(parentId ? [imageUrl(parentId, 'Primary')] : [])
    ];
  }

  function applyThemeFromBackdrop(blobUrl, expectedItemId, signal) {
    if (!blobUrl || !CONFIG.enableThemeColor) {
      applyThemeColor(overlay, null);
      return Promise.resolve();
    }

    const cachedColor = themeColorCache.get(blobUrl);
    if (cachedColor !== undefined) {
      applyThemeColor(overlay, cachedColor);
      return Promise.resolve(cachedColor);
    }

    return directorRequest('extractColor', { blobUrl }, signal)
      .then(color => {
        themeColorCache.set(blobUrl, color || null);
        if (currentItemId === expectedItemId) applyThemeColor(overlay, color);
        return color;
      })
      .catch(() => {});
  }

  function applyCachedBlurredBackdrop(el, blobUrl) {
    const cacheKey = `${blobUrl}_blur`;
    if (!imgBlobCache.has(cacheKey)) return false;
    el.style.backgroundImage = `url('${imgBlobCache.get(cacheKey)}')`;
    el.classList.remove('ps-blurred');
    return true;
  }

  function preBlurBackdrop(el, blobUrl, expectedItemId, signal) {
    if (!blobUrl || CONFIG.preBlurSize <= 0 || applyCachedBlurredBackdrop(el, blobUrl)) return;
    directorRequest('preBlur', {
      blobUrl,
      size: CONFIG.preBlurSize,
      passes: CONFIG.preBlurPasses || 3,
      blurRadius: CONFIG.preBlurRadius || 20
    }, signal)
      .then(res => {
        if (currentItemId === expectedItemId && res?.blurredBlob) {
          const blurUrl = URL.createObjectURL(res.blurredBlob);
          imgBlobCache.set(`${blobUrl}_blur`, blurUrl);
          el.style.backgroundImage = `url('${blurUrl}')`;
          el.classList.remove('ps-blurred');
        }
      })
      .catch(() => {});
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
      const withToken = servers.filter(s => s.AccessToken);
      // Fail closed. Falling back to "any stored token" would send server B's bearer token to
      // server A's origin whenever host matching misses (VPN/proxy hostname, IP vs DNS name).
      // A lone server is unambiguous, so it stays usable; two or more require a real host match.
      const server = withToken.find(serverMatchesCurrentHost)
        || (withToken.length === 1 ? withToken[0] : null);
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
      let nextUrl = imageUrl(activeBackdropItemId, 'Backdrop', nextIndex, backdropTags[nextIndex]);
      let nextBlob = await fetchAsBlob(nextUrl);
      if (currentItemId !== expectedItemId || !isOverlayVisible) return;
      if (!nextBlob) {
        maxBackdropIndex = nextIndex;
        if (maxBackdropIndex <= 1) return;
        nextIndex = 0;
        nextUrl = imageUrl(activeBackdropItemId, 'Backdrop', nextIndex, backdropTags[nextIndex]);
        nextBlob = await fetchAsBlob(nextUrl);
        if (!nextBlob) { maxBackdropIndex = 1; return; }
      }
      fgBackdropEl.style.transition = 'none';
      fgBackdropEl.style.backgroundImage = `url('${nextBlob}')`;
      if (isFallbackPrimary) fgBackdropEl.classList.add('ps-blurred'); else fgBackdropEl.classList.remove('ps-blurred');
      void fgBackdropEl.offsetWidth;
      fgBackdropEl.style.transition = `opacity ${CONFIG.backdropFadeMs}ms ease`;
      fgBackdropEl.style.opacity = '1';
      applyThemeFromBackdrop(nextBlob, expectedItemId);
      
      if (isFallbackPrimary && CONFIG.preBlurSize > 0) {
        preBlurBackdrop(fgBackdropEl, nextBlob, expectedItemId);
      }

      setTimeout(() => {
        if (currentItemId !== expectedItemId) return;
        bgBackdropEl.style.backgroundImage = `url('${nextBlob}')`;
        if (isFallbackPrimary) {
           if (!applyCachedBlurredBackdrop(bgBackdropEl, nextBlob)) bgBackdropEl.classList.add('ps-blurred');
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
        // Deliberately NO ?userId= here. Jellyfin's RequestHelpers.GetUserId falls back to the
        // token's own user when the parameter is absent (always correct), but throws
        // SecurityException("Forbidden") when a supplied userId belongs to someone else and the
        // caller is not an admin. Our stored userId is the *last* user recorded for this server,
        // so on a shared device it can be stale — passing it turns a working 200 into a 403.
        const resp = await fetch(`/Items/${itemId}`, { signal: fetchAbort.signal, headers: authHeaders });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const jsonText = await resp.text();
        data = await directorRequest('parseMetadata', { jsonText }, fetchAbort.signal);
        
        if (!VALID_ITEM_TYPES.has(data.Type)) {
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
    
    if (data && !VALID_ITEM_TYPES.has(data.Type)) {
      resetFetchState();
      return false;
    }
    
    if (currentItemId !== itemId) return false;
    originalTextHTML = sanitizeHTML(data.Overview || '');
    const isEpisode = data.Type === 'Episode', seriesId = data.SeriesId || null, parentId = data.ParentId || null;
    titleEl.textContent = isEpisode ? (data.SeriesName || data.Name) : data.Name;
    titleEl.style.setProperty('display', 'block', 'important');
    if (isEpisode && data.Name) {
      // `!= null`, not truthiness: season 0 (specials) is real and must still render as S00.
      // Live TV recordings and date-based episodes carry no numbers at all — omit rather than print "null".
      const season = data.ParentIndexNumber != null ? `S${String(data.ParentIndexNumber).padStart(2, '0')}` : '';
      const episode = data.IndexNumber != null ? `E${String(data.IndexNumber).padStart(2, '0')}` : '';
      const label = [season, episode].filter(Boolean).join(' · ');
      episodeEl.textContent = label ? `${label} — ${data.Name}` : data.Name;
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
        firstBackdropBlob = await fetchAsBlob(imageUrl(activeBackdropItemId, 'Backdrop', 0, backdropTags[0]), signal);
      }
      if (!firstBackdropBlob) {
        maxBackdropIndex = 1;
        const fallbacks = getFallbackBackdropUrls(itemId, parentId);
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
        applyThemeFromBackdrop(firstBackdropBlob, itemId, signal);

        if (isFallbackPrimary && CONFIG.preBlurSize > 0) {
          preBlurBackdrop(bgBackdropEl, firstBackdropBlob, itemId, signal);
        }

        if (isOverlayVisible && (maxBackdropIndex === null || maxBackdropIndex > 1)) cycleBackdrop(itemId);
      } else { bgBackdropEl.style.backgroundImage = 'none'; applyThemeColor(overlay, null); }
    })();

    const logoPromise = (async () => {
      const logoBlob = await fetchSequential(getLogoUrls(itemId, seriesId, parentId), signal);
      if (currentItemId !== itemId || !logoBlob) return;
      logoEl.src = logoBlob;
      logoEl.style.setProperty('display', 'block', 'important');
      titleEl.style.display = 'none';
      adjustLayout();
      const croppedLogoKey = `${logoBlob}_crop`;
      if (imgBlobCache.has(croppedLogoKey)) {
        logoEl.src = imgBlobCache.get(croppedLogoKey);
        adjustLayout();
        return;
      }
      directorRequest('autocrop', { 
        blobUrl: logoBlob, 
        step: CONFIG.logoCropScanStep || 2,
        alphaThreshold: CONFIG.logoCropAlphaThreshold !== undefined ? CONFIG.logoCropAlphaThreshold : 10,
        pad: CONFIG.logoCropPaddingPx !== undefined ? CONFIG.logoCropPaddingPx : 10
      }, signal).then(res => {
        if (currentItemId !== itemId || !res || !res.croppedBlob) return;
        const croppedUrl = URL.createObjectURL(res.croppedBlob);
        imgBlobCache.set(croppedLogoKey, croppedUrl);
        logoEl.src = croppedUrl;
        adjustLayout();
      }).catch(()=>{});
    })();

    const discPromise = (async () => {
      const discBlob = await fetchSequential(getDiscUrls(data, itemId, parentId), signal);
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

    // Let image assets load in the background; optional failures should stay quiet.
    void Promise.allSettled([backdropPromise, logoPromise, discPromise]);
    
    return true;
  }

  function handleDismissTouch() {
    if (!isDismissed) return;
    clearTimeout(dismissTimer);
    dismissTimer = setTimeout(restoreFromDismiss, CONFIG.touchDismissRestoreMs);
  }

  // Jellyfin shows its OSD on pointer activity, but its handler ignores `touch` pointers on
  // mobile, and we stop the X tap propagating anyway — so tapping the X could hide the
  // overlay while the controls stayed hidden underneath. Ask for them the way a mouse
  // would: `pointermove` with pointerType 'mouse', twice, ≥10px apart, because Jellyfin's
  // first move only seeds its last-position record and the threshold is 10px. Dispatched
  // from the player container so it bubbles through the OSD page and document alike, and
  // our own onPointerMove drops it as untrusted. Fails quiet if PointerEvent is missing.
  let osdNudgeSeq = 0;
  function nudgeJellyfinOsd() {
    if (typeof PointerEvent !== 'function' || typeof document === 'undefined') return;
    const target = document.querySelector('.videoPlayerContainer') || document.body;
    if (!target) return;
    osdNudgeSeq = (osdNudgeSeq + 1) % 4;
    const base = 20 + osdNudgeSeq * 40;
    for (const offset of [0, 40]) {
      const p = base + offset;
      try {
        target.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: false, pointerType: 'mouse', pointerId: 1, isPrimary: true,
          clientX: p, clientY: p, screenX: p, screenY: p
        }));
      } catch (_) { /* fail quiet: the overlay is already hidden, the X still did its job */ }
    }
  }

  function triggerDismiss(e) {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    if (isDismissed) return;
    isDismissed = true;
    overlay.style.setProperty('opacity', '0', 'important');
    overlay.style.pointerEvents = 'none';
    document.addEventListener('touchstart', handleDismissTouch, { passive: true });
    handleDismissTouch();
    nudgeJellyfinOsd();
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
    forceMouseReturnPending = false;
    const auth = getAuth();
    const freshId = getItemId(video);

    // Nothing to render and nothing rendered earlier: the overlay's own backdrop is opaque black,
    // so showing it here would paint a blank panel over the video that also swallows clicks.
    // Staying hidden leaves the player exactly as it was.
    if (!auth && !currentItemId) { isOverlayVisible = false; return; }

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
    
    // R1 residual: both frames re-check isOverlayVisible. Anything that runs between
    // scheduling and firing — purge()/resetOverlayState() from a media event, or an
    // ordinary hideOverlay() from onPlay/triggerActivityHide — has already set
    // display:none / opacity:0, and this chain would then paint visibility:visible and
    // opacity:1 back on top of it. The later hideOverlay() early-returns on
    // !isOverlayVisible, so those styles were never taken off again.
    requestAnimationFrame(() => {
      if (!isOverlayVisible) return;
      adjustLayout();
      requestAnimationFrame(() => {
        if (!isOverlayVisible) return;
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

  function triggerActivityHide({ ignoreOsdHover = false, forceReturn = false } = {}) {
    if (forceReturn) forceMouseReturnPending = true;
    hideOverlay();
    clearTimeout(mouseTimer);
    
    function attemptShow() {
      // If no longer paused or bound, stop retrying
      if (!video || !video.paused) {
        forceMouseReturnPending = false;
        return;
      }

      // Prevent showing if a native dialog or menu is actively open
      const isBlockingElementOpen = BLOCKING_ELEMENT_SELECTORS.some(sel => {
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
      if (osdHovered && !ignoreOsdHover && !forceMouseReturnPending) {
        mouseTimer = setTimeout(attemptShow, 500);
        return;
      }

      showOverlay();
    }

    mouseTimer = setTimeout(attemptShow, CONFIG.mouseShowDelay);
  }

  function onPointerMove(e) {
    // A synthetic move is ours (nudgeJellyfinOsd) or another script's — never a hand on a
    // mouse, so it must not trip the desktop mouse-return path below. Strict `=== false`:
    // real browsers always define isTrusted; the test shim's events may not, and those
    // must keep flowing.
    if (e.isTrusted === false) return;
    // B5/F2 sentinel site 1 of 5 — see isPauseScreenFacade(). The <video> branch is the
    // pre-4.2.0 expression, unchanged. This function is high-churn: the last two shipped
    // commits (aa5e774, 949f78e) were both bugfixes for it.
    if (e.pointerType === 'touch' || !video || !video.paused ||
        (isPauseScreenFacade(video) ? !hasStartedPlaying : video.currentTime === 0)) return;

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
      triggerActivityHide({ ignoreOsdHover: true, forceReturn: true });
      return;
    }
    resetIdleTimer();

    if (Date.now() - lastPauseTime < CONFIG.mouseHideDelay) return;
    triggerActivityHide({ forceReturn: true });
  }

  function onWheel(e) {
    // B5/F2 sentinel site 2 of 5.
    if (!video || !video.paused ||
        (isPauseScreenFacade(video) ? !hasStartedPlaying : video.currentTime === 0)) return;
    
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
    clearScreensaverState();
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

  function resetOverlayState() { stopScrollAnimation(); detachScrollDOM(); clearTimeout(mouseTimer); clearTimeout(touchReadyTimer); touchResumeReady = false; forceMouseReturnPending = false; isOverlayVisible = false; isDismissed = false; overlay.style.setProperty('display', 'none', 'important'); overlay.style.setProperty('opacity', '0', 'important'); }
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
  function resetScreensaverLogo() {
    screensaverLogoEl.style.opacity = '0';
    screensaverLogoEl.style.width = '';
    screensaverLogoEl.style.height = '';
    screensaverLogoEl.style.transform = '';
    screensaverLogoEl.style.transformOrigin = '';
    screensaverLogoEl.src = '';
  }

  function clearScreensaverState() {
    isScreensaver = false;
    clearTimeout(ssStartTimer);
    ssStartTimer = null;
    cancelAnimationFrame(ssRaf);
    ssRaf = null;
    overlay.classList.remove('ps-screensaver');
    resetScreensaverLogo();
    ssLogoX = 0;
    ssLogoY = 0;
  }

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
    const logoSrc = logoEl.currentSrc || logoEl.src || '';
    if (!logoSrc) {
      resetIdleTimer();
      return;
    }

    // Reuse the current logo asset and rendered size, but let the screensaver copy start centered.
    const logoRect = logoEl.getBoundingClientRect();
    if (!logoRect.width || !logoRect.height) {
      resetIdleTimer();
      return;
    }

    isScreensaver = true;
    stopScrollAnimation();

    const angle = Math.random() * Math.PI * 2;
    ssVelX = Math.cos(angle); ssVelY = Math.sin(angle);
    screensaverLogoEl.src = logoSrc;
    screensaverLogoEl.style.width = `${logoRect.width}px`;
    screensaverLogoEl.style.height = `${logoRect.height}px`;
    screensaverLogoEl.style.transformOrigin = 'top left';
    screensaverLogoEl.style.opacity = '0';

    overlay.classList.add('ps-screensaver');

    ssStartTimer = setTimeout(() => {
      if (!isScreensaver) return;
      ssLogoX = Math.max(0, (window.innerWidth - logoRect.width) / 2);
      ssLogoY = Math.max(0, (window.innerHeight - logoRect.height) / 2);
      screensaverLogoEl.style.transform = `translate3d(${ssLogoX}px, ${ssLogoY}px, 0) scale(1)`;
      screensaverLogoEl.style.opacity = '1';
      ssStartTime = performance.now();
      bounceLogo();
    }, SCREENSAVER_LOGO_DELAY_MS);
  }

  function exitScreensaver() {
    if (!isScreensaver) return;
    clearScreensaverState();
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

    if (isInAnyZone(e.target, SAFE_ZONE_SELECTORS)) {
      return;
    }

    // 2. Do not toggle if the user tapped directly on OSD controls
    if (isInAnyZone(e.target, OSD_TARGET_SELECTORS)) return;

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
    // A clean tap on the video surface. Record it BEFORE pausing: the `pause` event is
    // queued, not synchronous, and if Jellyfin's own tap handler paused first then
    // `video.paused` is already true here and our branch below never runs.
    lastScreenTapAt = Date.now();
    if (!video.paused) { video.pause(); return; }
  }

  function onPause() {
    // Consume the tap marker first, ahead of every early return, so a swallowed pause
    // cannot leave it armed for the next unrelated one.
    const tapPaused = Date.now() - lastScreenTapAt < TAP_PAUSE_WINDOW_MS;
    lastScreenTapAt = 0;
    if (!hasStartedPlaying) return; // Ignore pause events during initial load
    // B5/F2 sentinel site 3 of 5. Restored verbatim for a real <video>: this is the guard
    // that stops an autoplay-blocked page flashing a full opaque overlay at position 0.
    if (video && (isPauseScreenFacade(video) ? !hasStartedPlaying : video.currentTime === 0)) return; // Prevent flashing during auto-play initialization

    lastPauseTime = Date.now(); globalPauseTime = performance.now();
    clearTimeout(pauseShowTimer);
    // The tap that paused is also the tap that shows Jellyfin's controls: give them the
    // screen first. The overlay follows unless playback resumes meanwhile — onPlay clears
    // the timer and the timer re-checks `paused`. Any other pause (the OSD button, a media
    // key, desktop) shows immediately, exactly as before.
    const delay = tapPaused ? (CONFIG.pauseShowDelayTouchMs || 0) : 0;
    if (delay > 0) { pauseShowTimer = setTimeout(() => { if (video?.paused) showOverlay(); }, delay); } else { showOverlay(); }
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('wheel', onWheel, { passive: true });
  }

  function onPlay() {
    hasStartedPlaying = true;
    clearTimeout(pauseShowTimer); pauseShowTimer = null;
    forceMouseReturnPending = false;
    hideOverlay(); clearTimeout(mouseTimer);
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('wheel', onWheel);
  }
  function onEnded() { purge(); onPlay(); }
  function onSeeked() { if (isOverlayVisible && video && video.paused) updateProgress(); }

  // F2: `loadstart` / `emptied` are wired straight to purge(), exactly as in v4.1.1.
  // v4.2.0's first cut routed them through a wrapper that also cleared hasStartedPlaying,
  // to "re-arm" the B5 flag. That was both a browser regression (a mid-playback stream
  // change fires loadstart on the same element with no `play` to follow, so the flag
  // stayed false and every guard went dead for that stream) and unnecessary: on the
  // façade path the flag is true from bind onwards, because detectPlayerTarget() only
  // ever returns a façade AFTER Route C has captured a live `playbackstart`. There is no
  // window in which a façade is bound but playback has not begun, so nothing to re-arm.


  function onDocumentKeyDown(e) {
    if (e.key === 'Escape' && video) {
      const closeBtn = document.querySelector('.headerBackButton, .btnHeaderBack, .btn-back, [data-action="back"]');
      if (closeBtn) closeBtn.click();
    }

    // Wake from screensaver on any key
    if (isScreensaver) { exitScreensaver(); return; }

    // Arrow keys: seek ±N seconds and dismiss overlay
    // B5/F2 sentinel site 4 of 5. The seek below is a plain currentTime write — on the
    // façade that is a direct player.currentTime(ms) call, never playbackManager.seek(),
    // which would resume playback (B3).
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && video && video.paused &&
        (isPauseScreenFacade(video) ? hasStartedPlaying : video.currentTime !== 0)) {
      e.preventDefault();
      const secs = CONFIG.keyboardSeekSeconds || 10;
      video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + (e.key === 'ArrowRight' ? secs : -secs)));
      triggerActivityHide();
      return;
    }

    // Any other action key hides the overlay. B5/F2 sentinel site 5 of 5.
    if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key) && video && video.paused &&
        (isPauseScreenFacade(video) ? hasStartedPlaying : video.currentTime !== 0)) {
      triggerActivityHide();
    }
  }

  let handleLoadedMetadata = null;

  function bindVideo(el) {
    if (video === el) return; unbindVideo(); video = el; purge();
    // F2/F12. On a real <video> this stays `!el.paused`, byte-for-byte v4.1.1 — which
    // also means the `el.paused && hasStartedPlaying` check at the end of this function
    // remains dead on the browser path, exactly as it has always been. On the façade it
    // must be true unconditionally: detectPlayerTarget() only hands back a façade after
    // Route C captured a live `playbackstart`, so playback demonstrably HAS begun even
    // when the item was resumed straight into a paused state — and that is precisely the
    // case where the check below needs to fire and show the overlay.
    hasStartedPlaying = isPauseScreenFacade(el) ? true : !el.paused;
    
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

    if (isInAnyZone(e.target, OVERLAY_PROTECTED_SELECTORS)) {
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

    if (isInAnyZone(e.target, CLICK_PROTECTED_SELECTORS)) return;

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

  // detectPlayerTarget() returns the raw <video> element whenever one exists, so this is
  // the same object this line has always bound. It only ever returns something else — a
  // façade — when there is no <video> at all AND every kill switch is satisfied.
  const existingTarget = detectPlayerTarget();
  if (existingTarget) bindVideo(existingTarget);

  function destroy() {
    purge(); unbindVideo(); if (resizeObserver) resizeObserver.disconnect();
    exitScreensaver(); clearTimeout(idleTimer); idleTimer = null;
    clearTimeout(mouseTimer); clearTimeout(touchReadyTimer); clearTimeout(resizeDebounce); clearTimeout(pauseShowTimer); clearTimeout(dismissTimer); clearTimeout(userScrollTimeout);
    // R5: `wheel` is added in onPause alongside `pointermove` and was never removed here.
    // Harmless in v4.1.1 because destroy() only ran when the <video> left the DOM; on the
    // façade path destroy() now runs at every playbackstop, so stopping while paused
    // leaked one wheel listener per stop for the life of the page.
    document.removeEventListener('pointermove', onPointerMove); document.removeEventListener('wheel', onWheel); document.removeEventListener('touchstart', handleDismissTouch);
    overlay.removeEventListener('touchstart', onOverlayTouchStart); overlay.removeEventListener('touchend', onOverlayTouchEnd);
    imgBlobCache.clear(); itemCache.clear(); themeColorCache.clear(); overlay.remove();
    const styleTag = document.getElementById('pause-overlay-style');
    if (styleTag) styleTag.remove();
  }

  resizeObserver = new ResizeObserver(() => {
    if (isOverlayVisible && !isAdjusting) { clearTimeout(resizeDebounce); resizeDebounce = setTimeout(adjustLayout, 100); }
  });
  resizeObserver.observe(document.body);

  return { destroy, bindVideo, getVideo: () => video };
}
