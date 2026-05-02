(function () {
// v2.9.19 — UX Patch: Massively expanded ignored touch targets to prevent 
//           play/pause toggle from firing when interacting with OSD, dialogs, 
//           modals, or plugins like InPlayerEpisodePreview.
// ═══════════════════════════════════════════════════════════════════════════════
// ███  MASTER CONTROL
// ███  Everything you need to tweak is right here.
// ███  No need to dig through the code below — change it once, it applies everywhere.
// ═══════════════════════════════════════════════════════════════════════════════
const CONFIG = {

  // ─────────────────────────────────────────────────────────────────────────
  //  GENERAL
  // ─────────────────────────────────────────────────────────────────────────

  // How long (ms) after pausing before the overlay hides on mouse movement.
  mouseHideDelay: 500,

  // After the overlay hides from mouse movement, how long (ms) before it re-appears.
  mouseShowDelay: 1000,

  // ─────────────────────────────────────────────────────────────────────────
  //  BACKDROP CYCLING & THEME
  // ─────────────────────────────────────────────────────────────────────────

  // How dark the backdrop image gets. 0.0 = black, 1.0 = full brightness.
  backdropBrightness: 0.75,

  // Opacity of the dark edge gradient (vignette). 0.0 = invisible, 1.0 = pitch black.
  vignetteOpacity: 0.69,

  // How long (ms) to pause before crossfading to the next backdrop (if multiple exist).
  backdropCycleRestMs: 30000,

  // How long (ms) the backdrop crossfade transition takes.
  backdropFadeMs: 2000,

  // ─────────────────────────────────────────────────────────────────────────
  //  TOUCH BEHAVIOUR  (phones and tablets)
  // ─────────────────────────────────────────────────────────────────────────

  // Set to 0 to trigger the pause screen instantly on touch devices.
  pauseShowDelayTouchMs: 0,

  // Pixels of finger movement that counts as a swipe (not a tap).
  dragThresholdPx: 10,

  // Delay (ms) after overlay appears before a tap can resume playback.
  touchResumeDelayMs: 300,

  // How long (ms) the overlay stays hidden after tapping the 'X' dismiss button
  touchDismissRestoreMs: 5000,

  // ─────────────────────────────────────────────────────────────────────────
  //  DISC IMAGE & CACHE
  // ─────────────────────────────────────────────────────────────────────────

  discSpinSeconds: 60,
  blobCacheMaxSize: 20,

  // ─────────────────────────────────────────────────────────────────────────
  //  LAYOUT
  // ─────────────────────────────────────────────────────────────────────────

  genresMaxPhonePortrait: 1,   // Portrait phones (narrow screens)
  genresMaxDefault:       5,   // All other screens

  enableTextShadow: true,
  // Single, highly opaque layer for maximum performance without GPU scroll stutter
  textShadowDefinition: "0 4px 28px rgba(0,0,0,0.95)",

  // ─────────────────────────────────────────────────────────────────────────
  //  FONT SIZES  —  by screen type
  // ─────────────────────────────────────────────────────────────────────────
  fonts: {
    desktop: {
      title:        '3.4vw',
      episode:      '1.7vw',
      meta:         '1.1vw',
      ratingBadge:  '0.95vw',
      synopsis:     '2.4vw',
      progressMeta: '1vw',
    },
    phonePortrait: {
      title:        '8.5vw',
      episode:      '5vw',
      meta:         '3.8vw',
      ratingBadge:  '3vw',
      synopsis:     '8.2vw',
      progressMeta: '3.5vw',
    },
    tabletPortrait: {
      title:        '5.5vw',
      episode:      '3vw',
      meta:         '2.2vw',
      ratingBadge:  '1.8vw',
      synopsis:     '4.4vw', 
      progressMeta: '2vw',
    },
    phoneLandscape: {
      title:        '3.5vw',
      episode:      '2.2vw',
      meta:         '1.6vw',
      ratingBadge:  '1.3vw',
      synopsis:     '2.9vw', 
      progressMeta: '1.4vw',
    },
    tabletLandscape: {
      title:        '3.8vw',
      episode:      '2vw',
      meta:         '1.4vw',
      ratingBadge:  '1.1vw',
      synopsis:     '3.2vw',
      progressMeta: '1.2vw',
    },
    largeScreen: {
      title:        '2.6vw',
      synopsis:     '2.1vw',
      discMaxSize:  '15.5vw',
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  //  SYNOPSIS SCROLLING
  // ─────────────────────────────────────────────────────────────────────────
  synopsis: {
    // KEEP THESE AS PIXELS to ensure legibility on smaller screens / couches.
    minDefault:         24,
    minLargeScreen:     36,
    minTabletLandscape: 22,
    minTabletPortrait:  20,
    minPhonePortrait:   16,
    minPhoneLandscape:  14,
    descenderGuardPx:   24,

    scroll: {
      linesPerSecond: 0.57,
      initialHoldMs: 4000,
      scrollRampMs: 800,
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  //  MARGINS
  // ─────────────────────────────────────────────────────────────────────────
  margins: {
    desktop:        { top: 8,   left: 8,  right: 8,  bottom: 16 },
    portraitPhone:  { top: 7.2, left: 6,  right: 6,  bottom: 8  },
    portraitTablet: { top: 6,   left: 10, right: 10, bottom: 14 },
    landscapePhone: { top: 3.5, left: 7,  right: 7,  bottom: 11 },
    landscapeTablet:{ top: 6,   left: 8,  right: 8,  bottom: 16 },
    largeScreen:    { top: 8,   left: 8,  right: 8,  bottom: 16 },
  },
};
// ═══════════════════════════════════════════════════════════════════════════════
// ███  END MASTER CONTROL
// ═══════════════════════════════════════════════════════════════════════════════

// ── BOOTSTRAP / SPA LIFECYCLE ──────────────────────────────────────────────────
let instance = null;
let bootObserver = null;
let bootDebounce = null;

bootObserver = new MutationObserver((mutations) => {
  const hasNodeChanges = mutations.some(m => m.addedNodes.length > 0 || m.removedNodes.length > 0);
  if (!hasNodeChanges) return;

  clearTimeout(bootDebounce);
  bootDebounce = setTimeout(() => {
    const playerExists = !!document.querySelector('.videoPlayerContainer video');
    if (!instance && playerExists) {
        instance = createPauseScreen();
    } else if (instance && !playerExists) {
        instance.destroy();
        instance = null;
    }
  }, 100);
});
bootObserver.observe(document.documentElement, { childList: true, subtree: true });

if (document.querySelector('.videoPlayerContainer video')) instance = createPauseScreen();

// ── CORE APPLICATION ENGINE ────────────────────────────────────────────────────
function createPauseScreen() {
  
  let video = null, mouseTimer = null, fetchAbort = null;
  let currentItemId = null, renderedItemId = null, prefetchRetryTimer = null, pauseShowTimer = null;
  let resizeObserver = null, resizeDebounce = null, lastPauseTime = 0, globalPauseTime = 0, isAdjusting = false;
  const itemCache = makeLRUCache(50);

  const imgBlobCache = makeLRUBlobCache(CONFIG.blobCacheMaxSize);
  let currentCroppedLogoUrl = null; 
  let activeBackdropItemId = null;
  let maxBackdropIndex = null;
  let backdropTags = [];
  let authQueryCache = '';
  let activeBackdropIndex = 0;
  let backdropCycleTimer = null;
  let isFallbackPrimary = false;

  let touchStartX = 0, touchStartY = 0, touchResumeReady = false, touchReadyTimer = null;
  let scrollRAF = null, lastFrameTime = 0;
  let spacerEl = null, cloneEl = null, originalTextHTML = '';
  let isDismissed = false, dismissTimer = null, isOverlayVisible = false;
  let isFingerDown = false, isUserScrolling = false, userScrollTimeout = null;
  let currentScrollY = 0;

  function makeLRUBlobCache(limit) {
    const store = new Map();
    return {
      has: url => store.has(url),
      get(url) { const val = store.get(url); if (val !== undefined) { store.delete(url); store.set(url, val); } return val; },
      set(url, blobUrl) {
        if (store.has(url)) store.delete(url);
        store.set(url, blobUrl);
        if (store.size > limit) {
          const oldest = store.keys().next().value;
          URL.revokeObjectURL(store.get(oldest));
          store.delete(oldest);
        }
      },
      forEach: fn => store.forEach(fn),
      clear() { store.forEach(blobUrl => URL.revokeObjectURL(blobUrl)); store.clear(); }
    };
  }

  function makeLRUCache(limit) {
    const store = new Map();
    return {
      has: key => store.has(key),
      get(key) { const val = store.get(key); if (val !== undefined) { store.delete(key); store.set(key, val); } return val; },
      set(key, val) {
        if (store.has(key)) store.delete(key);
        store.set(key, val);
        if (store.size > limit) store.delete(store.keys().next().value);
      },
      clear() { store.clear(); }
    };
  }

  function sanitizeHTML(raw) {
    if (!raw) return '';
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    doc.querySelectorAll('script, style, iframe, object, embed, form, link').forEach(el => el.remove());
    doc.querySelectorAll('*').forEach(el => {
      for (const attr of [...el.attributes]) {
        if (attr.name.startsWith('on') || (attr.name === 'href' && attr.value.trimStart().startsWith('javascript:'))) {
          el.removeAttribute(attr.name);
        }
      }
    });
    return doc.body.innerHTML;
  }

  // ── THEME ENGINE: Extracts dominant hue via subsampled decode ──
  async function extractDominantColor(imgBlobUrl) {
    try {
      const resp = await fetch(imgBlobUrl);
      const blob = await resp.blob();
      const bmp = await createImageBitmap(blob, { resizeWidth: 4, resizeHeight: 3 });

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      canvas.width = 4; canvas.height = 3;
      ctx.drawImage(bmp, 0, 0);
      bmp.close();

      const data = ctx.getImageData(0, 0, 4, 3).data;

      let r = 0, g = 0, b = 0, count = 0;
      for (let i = 0; i < data.length; i += 4) {
        const red = data[i], green = data[i+1], blue = data[i+2];
        const max = Math.max(red, green, blue), min = Math.min(red, green, blue);
        if (max - min > 15) { r += red; g += green; b += blue; count++; }
      }

      if (count === 0) {
        for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i+1]; b += data[i+2]; count++; }
      }

      if (count > 0) return [Math.round(r/count), Math.round(g/count), Math.round(b/count)];
      return null;
    } catch { return null; }
  }

  function applyThemeColor(rgbArray) {
    if (!rgbArray) {
        overlay.style.setProperty('--theme-color', 'rgba(255,255,255,0.3)');
        overlay.style.setProperty('--theme-progress', 'rgba(255,255,255,0.9)');
        overlay.style.setProperty('--theme-glow', 'transparent');
        overlay.style.setProperty('--theme-glow-raw', 'transparent');
        return;
    }
    
    let [rawR, rawG, rawB] = rgbArray;
    let [r, g, b] = rgbArray;
    r /= 255; g /= 255; b /= 255;
    let max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    
    if (max === min) { h = s = 0; }
    else {
        let d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch(max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    
    s = Math.min(1, s + 0.30);
    l = Math.min(1, l + 0.30);
    
    let rNew, gNew, bNew;
    if (s === 0) {
        rNew = gNew = bNew = l;
    } else {
        let q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        let p = 2 * l - q;
        const hue2rgb = (p, q, t) => {
            if(t < 0) t += 1;
            if(t > 1) t -= 1;
            if(t < 1/6) return p + (q - p) * 6 * t;
            if(t < 1/2) return q;
            if(t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
        };
        rNew = hue2rgb(p, q, h + 1/3);
        gNew = hue2rgb(p, q, h);
        bNew = hue2rgb(p, q, h - 1/3);
    }
    
    const finalRgb = `rgb(${Math.round(rNew * 255)}, ${Math.round(gNew * 255)}, ${Math.round(bNew * 255)})`;
    const finalGlow = `rgba(${Math.round(rNew * 255)}, ${Math.round(gNew * 255)}, ${Math.round(bNew * 255)}, 0.80)`;
    const rawGlow = `rgba(${rawR}, ${rawG}, ${rawB}, 0.80)`;
    
    overlay.style.setProperty('--theme-color', finalRgb);
    overlay.style.setProperty('--theme-progress', finalRgb);
    overlay.style.setProperty('--theme-glow', finalGlow);
    overlay.style.setProperty('--theme-glow-raw', rawGlow);
  }

  // ── LOGO CROPPING: Canvas-based transparent pixel trimmer ──
  function autocropImage(imgBlobUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "Anonymous"; 
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        canvas.width = img.width; canvas.height = img.height;
        ctx.drawImage(img, 0, 0);

        let imageData;
        try {
          imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        } catch (e) {
          console.debug('[PauseScreen] Canvas tainted, skipping autocrop.');
          resolve(imgBlobUrl);
          return;
        }
        
        const data = imageData.data;
        let top = canvas.height, bottom = 0, left = canvas.width, right = 0;
        let found = false;
        
        const step = 16; 
        for (let y = 0; y < canvas.height; y += step) {
          for (let x = 0; x < canvas.width; x += step) {
            const alpha = data[(y * canvas.width + x) * 4 + 3];
            if (alpha > 10) { 
              found = true;
              if (y < top) top = y;
              if (y > bottom) bottom = y;
              if (x < left) left = x;
              if (x > right) right = x;
            }
          }
        }

        if (!found) { resolve(imgBlobUrl); return; } 

        const pad = 8; 
        top = Math.max(0, top - pad);
        bottom = Math.min(canvas.height - 1, bottom + pad);
        left = Math.max(0, left - pad);
        right = Math.min(canvas.width - 1, right + pad);

        const cropWidth = right - left + 1;
        const cropHeight = bottom - top + 1;
        
        if (cropWidth <= 0 || cropHeight <= 0) { resolve(imgBlobUrl); return; }

        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = cropWidth; cropCanvas.height = cropHeight;
        const cropCtx = cropCanvas.getContext('2d');
        cropCtx.drawImage(canvas, left, top, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

        cropCanvas.toBlob((blob) => {
          if (!blob) { resolve(imgBlobUrl); return; }
          
          if (currentCroppedLogoUrl) URL.revokeObjectURL(currentCroppedLogoUrl);
          currentCroppedLogoUrl = URL.createObjectURL(blob);
          
          resolve(currentCroppedLogoUrl);
        }, 'image/png');
      };
      img.onerror = () => resolve(imgBlobUrl);
      img.src = imgBlobUrl;
    });
  }

  // ── HELPERS & IDENTIFICATION ─────────────────────────────────────────────────
  function isPortrait()        { return window.matchMedia('(orientation: portrait)').matches; }
  function isPhoneLandscape()  { return window.matchMedia('(orientation: landscape) and (max-height: 500px)').matches; }
  function isPhonePortrait()   { return isPortrait() && window.innerWidth <= 600; }
  function isTabletLandscape() { return window.matchMedia('(orientation: landscape) and (min-height: 501px) and (pointer: coarse)').matches; }
  function getMaxGenres()      { return isPhonePortrait() ? CONFIG.genresMaxPhonePortrait : CONFIG.genresMaxDefault; }
  function parsePx(val)        { const n = parseFloat(val); return isNaN(n) ? 20 : (String(val).trim().endsWith('vw') ? n * window.innerWidth / 100 : n); }

  function getItemId() {
    const hashMatch = window.location.hash.match(/(?:id|itemId)=([a-f0-9]{32})/i) || window.location.search.match(/(?:id|itemId)=([a-f0-9]{32})/i);
    if (hashMatch) return hashMatch[1];

    const candidates = [
      document.querySelector('.btnUserRating'), document.querySelector('[data-id].btnUserRating'),
      document.querySelector('.videoOsdBottom button[data-id]'), document.querySelector('button[data-id][class*="Btn"]')
    ];
    for (const el of candidates) { const id = el?.dataset?.id; if (id && /^[a-f0-9]{32}$/i.test(id)) return id; }

    const poster = video?.getAttribute('poster') || '';
    const fromPoster = poster.match(/\/Items\/([a-f0-9]{32})\//i)?.[1];
    if (fromPoster) return fromPoster;

    return null;
  }

  function onOrientationChange() {
    if (isOverlayVisible && !isAdjusting) { clearTimeout(resizeDebounce); resizeDebounce = setTimeout(adjustLayout, 150); }
  }
  window.addEventListener('orientationchange', onOrientationChange);
  window.addEventListener('resize', onOrientationChange);

  // ── SCROLL ENGINE: Handles auto-scrolling and manual interruptions ──
  function stopScrollAnimation() { if (scrollRAF) { cancelAnimationFrame(scrollRAF); scrollRAF = null; } }
  function detachScrollDOM() { if (spacerEl?.parentNode) spacerEl.parentNode.removeChild(spacerEl); if (cloneEl?.parentNode) cloneEl.parentNode.removeChild(cloneEl); }
  function initScrollDOM() { if (!spacerEl) { spacerEl = document.createElement('div'); spacerEl.style.flexShrink = '0'; } if (!cloneEl) cloneEl = document.createElement('div'); }
  function easeOutQuad(t) { return t * (2 - t); }

  function startScrollAnimation() {
    stopScrollAnimation(); detachScrollDOM(); initScrollDOM();
    const cs = window.getComputedStyle(synopsisEl);
    
    let lineHeight = parseFloat(cs.lineHeight);
    if (isNaN(lineHeight) || lineHeight < 5) {
      lineHeight = parseFloat(cs.fontSize) * 1.5; 
    }

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

    synopsisEl.appendChild(spacerEl); cloneEl.innerHTML = originalTextHTML; synopsisEl.appendChild(cloneEl);
    
    const originalRect = originalBlock.getBoundingClientRect();
    const cloneRect = cloneEl.getBoundingClientRect();
    const loopResetPoint = cloneRect.top - originalRect.top; 
    
    currentScrollY = 0;
    synopsisEl.scrollTop = 0;
    isUserScrolling = false;
    isFingerDown = false;

    const fullSpeed = CONFIG.synopsis.scroll.linesPerSecond * lineHeight;
    const holdMs = CONFIG.synopsis.scroll.initialHoldMs;
    const rampMs = CONFIG.synopsis.scroll.scrollRampMs || 800; 
    

    lastFrameTime = performance.now(); 

    function animate(currentTime) {
      if (!lastFrameTime) lastFrameTime = currentTime;
      const delta = currentTime - lastFrameTime;
      lastFrameTime = currentTime;

      const timeSincePause = Date.now() - globalPauseTime;

      if (isUserScrolling || isFingerDown) {
        currentScrollY = synopsisEl.scrollTop;
        if (currentScrollY >= loopResetPoint) {
          currentScrollY -= loopResetPoint;
          synopsisEl.scrollTop = currentScrollY;
        } 
        scrollRAF = requestAnimationFrame(animate);
        return;
      }

      if (timeSincePause < holdMs) {
         currentScrollY = 0;
      } else if (timeSincePause < holdMs + rampMs) {
         const t = Math.min((timeSincePause - holdMs) / rampMs, 1);
         currentScrollY += ((fullSpeed * easeOutQuad(t)) * delta) / 1000;
         synopsisEl.scrollTop = currentScrollY;
      } else { 
         currentScrollY += (fullSpeed * delta) / 1000; 
         synopsisEl.scrollTop = currentScrollY;
      }

      if (currentScrollY >= loopResetPoint) {
        currentScrollY -= loopResetPoint;
        synopsisEl.scrollTop = currentScrollY; 
      }
      scrollRAF = requestAnimationFrame(animate);
    }
    scrollRAF = requestAnimationFrame(animate);
  }

  // ── TYPOGRAPHY: Binary search to fit synopsis inside dynamic bounds ──
  function adjustLayout() {
    if (isAdjusting) return; 
    isAdjusting = true;
    
    try {
      const isPhone = isPhonePortrait(), isLandPhone = isPhoneLandscape(), isTabLand = isTabletLandscape(), portrait = isPortrait(), SY = CONFIG.synopsis;
      stopScrollAnimation(); detachScrollDOM();

      synopsisEl.style.maxHeight = 'none'; synopsisEl.style.fontSize = ''; synopsisEl.style.webkitLineClamp = 'unset'; synopsisEl.style.webkitBoxOrient = 'unset';

      synopsisEl.innerHTML = originalTextHTML;
      void synopsisEl.offsetHeight;

      const availableHeight = Math.max(0, synopsisEl.getBoundingClientRect().height - SY.descenderGuardPx);
      let maxSize, minSize;
      
      if (portrait) { 
        maxSize = isPhone ? parsePx(CONFIG.fonts.phonePortrait.synopsis) : parsePx(CONFIG.fonts.tabletPortrait.synopsis); 
        minSize = isPhone ? SY.minPhonePortrait : (SY.minTabletPortrait || SY.minDefault); 
      }
      else if (isLandPhone) { maxSize = parsePx(CONFIG.fonts.phoneLandscape.synopsis); minSize = SY.minPhoneLandscape; }
      else if (isTabLand) { maxSize = parsePx(CONFIG.fonts.tabletLandscape.synopsis); minSize = SY.minTabletLandscape; }
      else if (window.innerWidth >= 2000) { maxSize = parsePx(CONFIG.fonts.largeScreen.synopsis); minSize = SY.minLargeScreen || SY.minDefault; }
      else { maxSize = parsePx(CONFIG.fonts.desktop.synopsis); minSize = SY.minDefault; }

      const clone = synopsisEl.cloneNode(true);
      clone.style.visibility = 'hidden';
      clone.style.position = 'absolute';
      clone.style.pointerEvents = 'none';
      clone.style.width = window.getComputedStyle(synopsisEl).width;
      
      clone.style.height = 'auto';
      clone.style.maxHeight = 'none';
      clone.style.flex = 'none';
      
      synopsisEl.parentNode.appendChild(clone);

      let low = minSize, high = maxSize, bestFit = minSize;
      while (low <= high) {
        const mid = low + (high - low) / 2; clone.style.fontSize = mid + 'px';
        if (clone.scrollHeight <= availableHeight) { bestFit = mid; low = mid + 0.25; } else { high = mid - 0.25; }
      }
      
      clone.remove(); 
      synopsisEl.style.fontSize = bestFit + 'px'; 
      synopsisEl.style.maxHeight = availableHeight + 'px'; 
      
    } finally {
      requestAnimationFrame(() => { isAdjusting = false; startScrollAnimation(); });
    }
  }

  // ── NETWORK & SEQUENTIAL BACKDROP CYCLING ────────────────────────────────────
  async function fetchAsBlob(url) {
    if (imgBlobCache.has(url)) return imgBlobCache.get(url);
    try { 
      const opts = fetchAbort?.signal ? { signal: fetchAbort.signal } : {};
      const resp = await fetch(url, opts); 
      if (!resp.ok) return null; 
      const blobUrl = URL.createObjectURL(await resp.blob()); 
      imgBlobCache.set(url, blobUrl); 
      return blobUrl; 
    } catch { return null; }
  }
  
  async function fetchSequential(urls) {
    for (const url of urls) {
      const blob = await fetchAsBlob(url);
      if (blob) return blob;
    }
    return null;
  }

  function getAuth() {
    try {
      const raw = localStorage.getItem('jellyfin_credentials');
      if (!raw) return null;
      const creds = JSON.parse(raw);
      const server = creds?.Servers?.find(s => s.AccessToken) || creds?.Servers?.[0];
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
      
      if (maxBackdropIndex !== null && nextIndex >= maxBackdropIndex) {
          nextIndex = 0;
      }
      
      const tagQuery = backdropTags[nextIndex] ? `&tag=${backdropTags[nextIndex]}` : '';
      let nextUrl = `/Items/${activeBackdropItemId}/Images/Backdrop/${nextIndex}${authQueryCache}${tagQuery}`;
      let nextBlob = await fetchAsBlob(nextUrl);
      
      if (currentItemId !== expectedItemId || !isOverlayVisible) return;
      
      if (!nextBlob) {
          maxBackdropIndex = nextIndex; 
          if (maxBackdropIndex <= 1) return; 
          
          nextIndex = 0;
          const fallbackTagQuery = backdropTags[nextIndex] ? `&tag=${backdropTags[nextIndex]}` : '';
          nextUrl = `/Items/${activeBackdropItemId}/Images/Backdrop/${nextIndex}${authQueryCache}${fallbackTagQuery}`;
          nextBlob = await fetchAsBlob(nextUrl);
          
          if (!nextBlob) {
              maxBackdropIndex = 1; 
              return; 
          }
      }
      
      fgBackdropEl.style.transition = 'none';
      fgBackdropEl.style.backgroundImage = `url('${nextBlob}')`;
      if (isFallbackPrimary) fgBackdropEl.classList.add('ps-blurred'); else fgBackdropEl.classList.remove('ps-blurred');
      
      void fgBackdropEl.offsetWidth; 
      
      fgBackdropEl.style.transition = `opacity ${CONFIG.backdropFadeMs}ms ease`;
      fgBackdropEl.style.opacity = '1';
      extractDominantColor(nextBlob).then(applyThemeColor);
      
      setTimeout(() => {
          if (currentItemId !== expectedItemId) return; 
          bgBackdropEl.style.backgroundImage = `url('${nextBlob}')`;
          if (isFallbackPrimary) bgBackdropEl.classList.add('ps-blurred'); else bgBackdropEl.classList.remove('ps-blurred');
          
          fgBackdropEl.style.transition = 'none';
          fgBackdropEl.style.opacity = '0';
          activeBackdropIndex = nextIndex;
          
          if (isOverlayVisible) cycleBackdrop(expectedItemId);
      }, CONFIG.backdropFadeMs + 50); 
        
    }, CONFIG.backdropCycleRestMs);
  }

  // ── THE WATERFALL: Non-blocking staggered asset fetch ──
  async function fetchAndApplyMetadata(itemId, auth) {
    if (itemId === renderedItemId || itemId === currentItemId) return;
    if (fetchAbort) { fetchAbort.abort(); fetchAbort = null; }
    currentItemId = itemId; fetchAbort = new AbortController(); resetDOMContent();

    authQueryCache = `?ApiKey=${auth.token}`; let data;
    if (itemCache.has(itemId)) { data = itemCache.get(itemId); }
    else {
      try { 
        const resp = await fetch(`/Items/${itemId}${authQueryCache}`, { signal: fetchAbort.signal }); 
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`); 
        data = await resp.json(); 
        itemCache.set(itemId, data); 
      } catch (err) { 
        if (err.name !== 'AbortError') console.error('[PauseScreen] Metadata fetch failed:', err); 
        return; 
      }
    }
    if (currentItemId !== itemId) return;

    // STEP 1: Instant Text Render (Zero Thread Blocking)
    originalTextHTML = sanitizeHTML(data.Overview || '');
    const isEpisode = data.Type === 'Episode', seriesId = data.SeriesId || null, parentId = data.ParentId || null;
    
    titleEl.textContent = isEpisode ? (data.SeriesName || data.Name) : data.Name; 
    titleEl.style.setProperty('display', 'block', 'important');
    if (isEpisode && data.Name) { episodeEl.textContent = `S${String(data.ParentIndexNumber).padStart(2,'0')} · E${String(data.IndexNumber).padStart(2,'0')} — ${data.Name}`; episodeEl.style.setProperty('display', 'block', 'important'); }
    metaYear.textContent = data.ProductionYear || ''; metaRating.textContent = data.OfficialRating || ''; metaRating.style.display = data.OfficialRating ? 'inline' : 'none';
    metaGenres.textContent = data.Genres?.slice(0, getMaxGenres()).join(' · ') || ''; metaStar.textContent = data.CommunityRating ? `★ ${data.CommunityRating.toFixed(1)}` : '';
    if (data.RunTimeTicks) { const totalMins = Math.floor(data.RunTimeTicks / 600000000); metaRuntime.textContent = `${Math.floor(totalMins / 60)}h ${totalMins % 60}m`; } else { metaRuntime.textContent = ''; }
    synopsisEl.textContent = originalTextHTML;
    
    renderedItemId = itemId; 
    adjustLayout(); 

    // STEP 2: Async Backdrop & Theme Engine
    (async () => {
        activeBackdropItemId = data.Id;
        maxBackdropIndex = data.BackdropImageTags?.length || 0;
        backdropTags = data.BackdropImageTags || [];
        isFallbackPrimary = false;

        if (maxBackdropIndex === 0) {
            if (data.ParentBackdropImageTags?.length > 0) {
                activeBackdropItemId = data.ParentBackdropItemId;
                maxBackdropIndex = data.ParentBackdropImageTags.length;
                backdropTags = data.ParentBackdropImageTags;
            } else if (seriesId) {
                activeBackdropItemId = seriesId;
                maxBackdropIndex = null; 
            } else if (parentId) {
                activeBackdropItemId = parentId;
                maxBackdropIndex = null; 
            }
        }

        let firstBackdropBlob = null;
        activeBackdropIndex = 0;

        if (activeBackdropItemId) {
            const tagQuery = backdropTags[0] ? `&tag=${backdropTags[0]}` : '';
            firstBackdropBlob = await fetchAsBlob(`/Items/${activeBackdropItemId}/Images/Backdrop/0${authQueryCache}${tagQuery}`);
        }

        if (!firstBackdropBlob) {
            maxBackdropIndex = 1; 
            const fallbacks = [
                `/Items/${itemId}/Images/Thumb${authQueryCache}`,
                ...(parentId ? [`/Items/${parentId}/Images/Thumb${authQueryCache}`] : []),
                `/Items/${itemId}/Images/Primary${authQueryCache}`,
                ...(parentId ? [`/Items/${parentId}/Images/Primary${authQueryCache}`] : [])
            ];
            
            for (let f of fallbacks) {
                const b = await fetchAsBlob(f);
                if (b) {
                    firstBackdropBlob = b;
                    if (f.includes('/Primary') && !isEpisode) isFallbackPrimary = true;
                    break;
                }
            }
        }

        if (currentItemId !== itemId) return;

        if (firstBackdropBlob) {
          bgBackdropEl.style.backgroundImage = `url('${firstBackdropBlob}')`;
          if (isFallbackPrimary) {
              bgBackdropEl.classList.add('ps-blurred');
              fgBackdropEl.classList.add('ps-blurred');
          } else {
              bgBackdropEl.classList.remove('ps-blurred');
              fgBackdropEl.classList.remove('ps-blurred');
          }
          
          extractDominantColor(firstBackdropBlob).then(c => {
             if (currentItemId === itemId) applyThemeColor(c);
          });
          
          if (isOverlayVisible && (maxBackdropIndex === null || maxBackdropIndex > 1)) {
              cycleBackdrop(itemId);
          }
        } else {
          bgBackdropEl.style.backgroundImage = 'none';
          applyThemeColor(null);
        }
    })();

    // STEP 3: Async Logo Engine
    (async () => {
        const logoUrls = [...(seriesId ? [`/Items/${seriesId}/Images/Logo${authQueryCache}`] : []), ...(parentId ? [`/Items/${parentId}/Images/Logo${authQueryCache}`] : []), `/Items/${itemId}/Images/Logo${authQueryCache}`];
        const logoBlob = await fetchSequential(logoUrls);
        if (currentItemId !== itemId || !logoBlob) return;

        logoEl.src = logoBlob; 
        logoEl.style.setProperty('display', 'block', 'important'); 
        titleEl.style.display = 'none';
        adjustLayout(); 

        autocropImage(logoBlob).then(cropped => {
            if (currentItemId !== itemId || !cropped) return;
            logoEl.src = cropped;
            adjustLayout(); 
        });
    })();

    // STEP 4: Async Disc Engine
    (async () => {
        const discUrls = data.Type === 'Movie' ? [`/Items/${itemId}/Images/Disc${authQueryCache}`, ...(parentId ? [`/Items/${parentId}/Images/Disc${authQueryCache}`] : [])] : [];
        const discBlob = await fetchSequential(discUrls);
        if (currentItemId !== itemId) return;
        
        const hasDisc = !!discBlob; 
        discEl.dataset.hasDisc = String(hasDisc); 
        discEl.style.display = 'none';
        if (hasDisc) { 
           discEl.src = discBlob; 
           if (!isPortrait()) discEl.style.display = 'block'; 
           rightCol.classList.remove('ps-no-disc'); 
           rightCol.style.display = ''; 
        } else { 
           discEl.src = ''; 
           rightCol.classList.add('ps-no-disc'); 
           rightCol.style.display = 'none'; 
        }
    })();
  }

  // ── VISIBILITY: Show, Hide, and Dismiss Overlay ──
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
    
    try {
      setTimeout(() => {
        const playerContainer = document.querySelector('.videoPlayerContainer');
        if (playerContainer) {
          playerContainer.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        }
      }, 50);
    } catch(err) { console.debug('[PauseScreen] OSD wakeup trigger failed.'); }
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
    isOverlayVisible = true;
    const auth = getAuth(); 
    const freshId = getItemId(); 
    if (auth && freshId) fetchAndApplyMetadata(freshId, auth);
    updateProgress();

    isDismissed = false; clearTimeout(dismissTimer);
    document.removeEventListener('touchstart', handleDismissTouch);

    overlay.style.setProperty('display', 'block', 'important'); overlay.style.setProperty('opacity', '0', 'important'); overlay.style.visibility = 'hidden';
    overlay.style.pointerEvents = 'auto'; 

    if ((maxBackdropIndex === null || maxBackdropIndex > 1) && !backdropCycleTimer) { cycleBackdrop(currentItemId); }

    requestAnimationFrame(() => { adjustLayout(); requestAnimationFrame(() => { overlay.style.visibility = 'visible'; void overlay.offsetHeight; overlay.style.setProperty('opacity', '1', 'important'); }); });
    enableTouchResume();
  }

  function hideOverlay() {
    if (!isOverlayVisible) return;
    isOverlayVisible = false;
    overlay.style.setProperty('opacity', '0', 'important');
    clearTimeout(mouseTimer); clearTimeout(touchReadyTimer); touchResumeReady = false; 
    clearTimeout(backdropCycleTimer); backdropCycleTimer = null; 
    isDismissed = false; clearTimeout(dismissTimer); document.removeEventListener('touchstart', handleDismissTouch);
    setTimeout(() => { if (!isOverlayVisible) overlay.style.setProperty('display', 'none', 'important'); }, 350);
  }

  function onPointerMove(e) {
    if (e.pointerType !== 'mouse' || !video?.paused) return; 
    if (Date.now() - lastPauseTime < CONFIG.mouseHideDelay) return;
    hideOverlay(); clearTimeout(mouseTimer); mouseTimer = setTimeout(showOverlay, CONFIG.mouseShowDelay);
  }
  function enableTouchResume() { clearTimeout(touchReadyTimer); touchResumeReady = false; touchReadyTimer = setTimeout(() => { touchResumeReady = true; }, CONFIG.touchResumeDelayMs); }

  function resetFetchState() { if (fetchAbort) { fetchAbort.abort(); fetchAbort = null; } clearTimeout(prefetchRetryTimer); prefetchRetryTimer = null; clearTimeout(pauseShowTimer); pauseShowTimer = null; currentItemId = null; renderedItemId = null; lastPauseTime = 0; activeBackdropItemId = null; maxBackdropIndex = null; authQueryCache = ''; activeBackdropIndex = 0; clearTimeout(backdropCycleTimer); backdropCycleTimer = null; isFallbackPrimary = false; backdropTags = []; }
  function resetDOMContent() {
    // Backdrop
    bgBackdropEl.style.backgroundImage = '';
    fgBackdropEl.style.backgroundImage = '';
    fgBackdropEl.style.transition = 'none';
    fgBackdropEl.style.opacity = '0';
    bgBackdropEl.classList.remove('ps-blurred');
    fgBackdropEl.classList.remove('ps-blurred');

    // Logo & titles
    logoEl.style.display = 'none'; logoEl.src = '';
    titleEl.style.display = 'none'; titleEl.textContent = '';
    episodeEl.style.display = 'none'; episodeEl.textContent = '';

    // Metadata
    metaYear.textContent = '';
    metaRating.textContent = ''; metaRating.style.display = 'none';
    metaRuntime.textContent = '';
    metaGenres.textContent = '';
    metaStar.textContent = '';

    // Synopsis
    synopsisEl.textContent = '';
    synopsisEl.style.fontSize = '';
    synopsisEl.style.maxHeight = 'none';
    synopsisEl.style.maskImage = 'none';
    synopsisEl.style.webkitMaskImage = 'none';
    originalTextHTML = '';

    // Disc
    discEl.style.display = 'none'; discEl.src = '';
    discEl.dataset.hasDisc = 'false';
    rightCol.style.display = 'none';
    rightCol.classList.remove('ps-no-disc');

    // Progress
    progressFill.style.width = '0%';
    progressTime.textContent = '';
    progressPct.textContent = '';
    progressEnd.textContent = '';

    applyThemeColor(null);
  }
  function resetOverlayState() { stopScrollAnimation(); detachScrollDOM(); clearTimeout(mouseTimer); clearTimeout(touchReadyTimer); touchResumeReady = false; isOverlayVisible = false; overlay.style.setProperty('display', 'none', 'important'); overlay.style.setProperty('opacity', '0', 'important'); }
  function purge() { resetFetchState(); resetDOMContent(); resetOverlayState(); }

  function formatClock(s) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60); return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`; }
  
  function updateProgress() { 
    if (!video) return; 
    const current = video.currentTime, duration = video.duration || 0; 
    const pct = duration > 0 ? (current / duration) * 100 : 0; 
    const endsAt = new Date(Date.now() + (duration - current) * 1000); 
    progressFill.style.width = `${pct}%`; 
    progressTime.textContent = `${formatClock(current)} / ${formatClock(duration)}`; 
    progressPct.textContent = `${Math.round(pct)}% watched`; 
    progressEnd.textContent = `Ends at ${endsAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`; 
  }

  let globalTouchStartX = 0, globalTouchStartY = 0;

  function onGlobalTouchStart(e) {
    globalTouchStartX = e.touches[0].clientX;
    globalTouchStartY = e.touches[0].clientY;
  }

  function onGlobalScreenTap(e) {
    if (!video) return;
    
    const dx = Math.abs(e.changedTouches[0].clientX - globalTouchStartX);
    const dy = Math.abs(e.changedTouches[0].clientY - globalTouchStartY);
    if (dx > CONFIG.dragThresholdPx || dy > CONFIG.dragThresholdPx) return;

    // v2.9.19: Expanded ignore list for native UI, Modals, and Plugins
    const ignoreClasses = [
      '.osdControls', '.videoOsdBottom', '.sliderContainer', 'button', 'a', 'input',
      '.upNextContainer', '.ps-close-btn',
      '.dialogContainer', '.dialog', '.formDialog', '[role="dialog"]',
      '.mainDrawer', '.actionSheet', '.paperList', '.listItem', '.actionsheetDivider',
      '[role="button"]', '[role="menu"]', '[role="menuitem"]', '[role="tab"]', 
      '[role="slider"]', '[role="listbox"]', '[role="option"]',
      '.focuscontainer', '.paper-icon-button-light'
    ];
    if (e.target.closest(ignoreClasses.join(', '))) return;

    if (!video.paused) {
      e.preventDefault();
      e.stopPropagation(); 
      video.pause();
    } else if (video.paused && isDismissed) {
      e.preventDefault();
      e.stopPropagation();
      video.play().catch(() => {});
    }
  }

  function onPause() {
    lastPauseTime = Date.now(); globalPauseTime = Date.now();
    clearTimeout(pauseShowTimer); 
    const delay = CONFIG.pauseShowDelayTouchMs || 0;
    if (delay > 0) { pauseShowTimer = setTimeout(() => { if (video?.paused) showOverlay(); }, delay); } else { showOverlay(); }
    document.addEventListener('pointermove', onPointerMove);
  }
  
  function onPlay() { clearTimeout(pauseShowTimer); pauseShowTimer = null; hideOverlay(); clearTimeout(mouseTimer); document.removeEventListener('pointermove', onPointerMove); }
  function onEnded() { purge(); onPlay(); }

  // Global ESC handler (Fix 1: works even when playing)
  function onDocumentKeyDown(e) {
    if (e.key === 'Escape') {
      const closeBtn = document.querySelector('.headerBackButton, .btnHeaderBack, .btn-back, [data-action="back"]');
      if (closeBtn) closeBtn.click();
    }
  }

  function bindVideo(el) {
    if (video === el) return; unbindVideo(); video = el; purge();
    el.addEventListener('loadstart', purge); el.addEventListener('emptied', purge); el.addEventListener('ended', onEnded); el.addEventListener('pause', onPause); el.addEventListener('play', onPlay);
    el.addEventListener('seeked', updateProgress);
    
    document.body.addEventListener('touchstart', onGlobalTouchStart, { passive: true });
    document.body.addEventListener('touchend', onGlobalScreenTap, { passive: false });
    document.addEventListener('keydown', onDocumentKeyDown);

    function prefetchMetadata() {
      purge(); const auth = getAuth(); if (!auth) return; let attempts = 0; const maxAttempts = 10;
      function tryFetch() { const id = getItemId(); if (id) { fetchAndApplyMetadata(id, auth); } else if (++attempts < maxAttempts) { prefetchRetryTimer = setTimeout(tryFetch, 250); } }
      prefetchRetryTimer = setTimeout(tryFetch, 2000); 
    }
    if (el.readyState >= 1) prefetchMetadata(); else el.addEventListener('loadedmetadata', prefetchMetadata, { once: true });
  }

  function unbindVideo() {
    if (!video) return;
    video.removeEventListener('loadstart', purge); video.removeEventListener('emptied', purge); video.removeEventListener('ended', onEnded); video.removeEventListener('pause', onPause); video.removeEventListener('play', onPlay);
    video.removeEventListener('seeked', updateProgress);
    document.body.removeEventListener('touchstart', onGlobalTouchStart);
    document.body.removeEventListener('touchend', onGlobalScreenTap);
    document.removeEventListener('keydown', onDocumentKeyDown);
    video = null;
  }

  if ('ResizeObserver' in window) { 
    resizeObserver = new ResizeObserver(() => { 
        if (!isOverlayVisible) return;
        clearTimeout(resizeDebounce); 
        resizeDebounce = setTimeout(() => {
            if (!isAdjusting) adjustLayout();
        }, 100); 
    }); 
    resizeObserver.observe(document.body); 
  }

  // ── CSS STYLES & DOM INJECTION ────────────────────────────────────────────────
  if (!document.getElementById('pause-overlay-style')) {
    const F = CONFIG.fonts, M = CONFIG.margins;
    const TS = `text-shadow: ${CONFIG.enableTextShadow ? CONFIG.textShadowDefinition : 'none'};`;
    const styleEl = document.createElement('style'); styleEl.id = 'pause-overlay-style';
    
    styleEl.textContent = `
      @keyframes ps-spin-ls { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { #pause-overlay .ps-disc { animation: none !important; } }
      #pause-overlay *::-webkit-scrollbar { display: none; } #pause-overlay * { box-sizing: border-box; }
      
      #pause-overlay .ps-backdrop-bg, #pause-overlay .ps-backdrop-fg { position: absolute; inset: 0; background-color: #000; background-size: cover; background-position: center; filter: brightness(${CONFIG.backdropBrightness}); will-change: opacity, filter, transform; }
      #pause-overlay .ps-backdrop-fg { opacity: 0; }
      #pause-overlay .ps-backdrop-bg.ps-blurred, #pause-overlay .ps-backdrop-fg.ps-blurred { filter: brightness(${CONFIG.backdropBrightness}) blur(25px); transform: scale(1.2); }
      
      #pause-overlay .ps-vignette { position: absolute; inset: 0; background: radial-gradient(ellipse at center, transparent 0%, rgba(0,0,0,${CONFIG.vignetteOpacity}) 100%); pointer-events: none; }
      #pause-overlay .ps-layout { position: absolute; top: ${M.desktop.top}vh; left: ${M.desktop.left}vw; right: ${M.desktop.right}vw; bottom: calc(${M.desktop.bottom}vh + env(safe-area-inset-bottom, 16px)); display: flex; gap: 6vw; flex-direction: row; }
      @supports (height: 100dvh) { #pause-overlay .ps-layout { top: ${M.largeScreen.top}dvh; bottom: calc(${M.largeScreen.bottom}dvh + env(safe-area-inset-bottom, 16px)); } }
      
      #pause-overlay .ps-left { flex: 2; display: flex; flex-direction: column; justify-content: center; overflow: visible; color: white; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; min-height: 0; height: 100%; }
      #pause-overlay .ps-right { flex: 1; display: flex; justify-content: center; align-items: center; position: relative; }
      
      #pause-overlay .ps-logo { display: none; max-width: 30vw; height: auto; max-height: 138px; object-fit: contain; object-position: left; margin-bottom: 2vh; flex-shrink: 0; }
      
      #pause-overlay .ps-title { display: none; font-size: ${F.desktop.title}; font-weight: 700; line-height: 1.05; letter-spacing: -0.01em; color: white; ${TS} margin-bottom: 1.2vh; flex-shrink: 0; padding: 4px; margin-left: -4px; margin-top: -4px; }
      #pause-overlay .ps-episode { display: none; font-size: ${F.desktop.episode}; font-weight: 600; letter-spacing: 0.01em; color: rgba(255,255,255,0.85); ${TS} margin-bottom: 1.2vh; flex-shrink: 0; padding: 4px; margin-left: -4px; margin-top: -4px; }
      #pause-overlay .ps-meta { display: flex; align-items: center; gap: 1vw; flex-wrap: nowrap; margin-bottom: 0; flex-shrink: 0; font-size: ${F.desktop.meta}; color: rgba(255,255,255,0.65); letter-spacing: 0.015em; ${TS} width: 100%; min-width: 0; padding: 4px; margin-left: -4px; margin-top: -4px; white-space: nowrap; }
      #pause-overlay .ps-meta > span { white-space: nowrap; flex-shrink: 1; min-width: 0; } 
      #pause-overlay .ps-meta .ps-genres { overflow: hidden; text-overflow: ellipsis; flex-shrink: 3; padding: 10px 0; margin: -10px 0; }
      #pause-overlay .ps-rating-badge { border: 1px solid rgba(255,255,255,0.4); border-radius: 2px; flex-shrink: 0; font-weight: 500; font-size: ${F.desktop.ratingBadge}; padding: 0.15vh 0.5vw; }
      
      #pause-overlay .ps-divider { width: 40px; height: 1.5px; background: var(--theme-color, rgba(255,255,255,0.3)); box-shadow: 0 0 20px var(--theme-glow, transparent), 0 0 40px var(--theme-glow, transparent); margin: 2vh 0; flex-shrink: 0; border-radius: 1px; transition: background-color 2s ease, box-shadow 2s ease; }
      
      #pause-overlay .ps-synopsis { padding: 0 20px; margin: 0 -20px; font-size: ${F.desktop.synopsis}; line-height: 1.5; color: rgba(255,255,255,0.92); flex: 1 1 0%; min-height: 0; height: 100%; ${TS} position: relative; overflow: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; -ms-overflow-style: none; touch-action: pan-y; }
      
      #pause-overlay .ps-disc { display: none; width: 100%; height: auto; aspect-ratio: 1 / 1; object-fit: contain; border-radius: 50%; animation: ps-spin-ls var(--disc-spin-speed, 60s) linear infinite; filter: brightness(0.85) drop-shadow(0 8px 16px rgba(0,0,0,0.4)) drop-shadow(0 0 80px var(--theme-glow-raw, transparent)); transition: filter 2s ease; }
      @media (orientation: landscape) { #pause-overlay .ps-disc { display: block; } } @media (orientation: portrait) { #pause-overlay .ps-disc { display: none !important; } }
      
      #pause-overlay .ps-progress-wrap { position: absolute; bottom: calc(7vh + env(safe-area-inset-bottom, 16px)); left: ${M.desktop.left}vw; right: ${M.desktop.right}vw; }
      @supports (height: 100dvh) { #pause-overlay .ps-progress-wrap { bottom: calc(7dvh + env(safe-area-inset-bottom, 16px)); } }
      #pause-overlay .ps-progress-track { width: 100%; height: 4px; background: rgba(255,255,255,0.2); border-radius: 2px; margin-bottom: 1vh; }
      #pause-overlay .ps-progress-fill { height: 100%; background: var(--theme-progress, rgba(255,255,255,0.9)); border-radius: 2px; width: 0%; transition: width 0.25s ease, background-color 2s ease; }
      #pause-overlay .ps-progress-meta { display: flex; gap: 0.8vw; align-items: center; font-family: inherit; font-size: ${F.desktop.progressMeta}; color: rgba(255,255,255,0.65); ${TS} }

      #pause-overlay .ps-close-btn { position: absolute; top: max(2vh, env(safe-area-inset-top, 20px)); right: max(3vw, env(safe-area-inset-right, 20px)); width: 44px; height: 44px; background: rgba(0,0,0,0.3); border: 1.5px solid rgba(255,255,255,0.4); border-radius: 50%; color: rgba(255,255,255,0.85); font-size: 20px; display: flex; justify-content: center; align-items: center; z-index: 2147483647; pointer-events: auto; backdrop-filter: blur(4px); font-family: sans-serif; font-weight: 300; touch-action: manipulation; }
      @media (pointer: fine) { #pause-overlay .ps-close-btn { display: none !important; } } 

      @media (orientation: portrait) {
        #pause-overlay .ps-layout { flex-direction: column; gap: 2.5vh; top: calc(${M.portraitTablet.top}vh + env(safe-area-inset-top, ${M.portraitTablet.top}vh)); bottom: calc(${M.portraitTablet.bottom}vh + env(safe-area-inset-bottom, 16px)); }
        @supports (height: 100dvh) { #pause-overlay .ps-layout { top: calc(${M.portraitTablet.top}dvh + env(safe-area-inset-top, ${M.portraitTablet.top}dvh)); bottom: calc(${M.portraitTablet.bottom}dvh + env(safe-area-inset-bottom, 16px)); } }
        #pause-overlay .ps-right { display: none !important; position: absolute; visibility: hidden; }
        #pause-overlay .ps-left { flex: 1; min-height: 0; height: 100%; justify-content: flex-start; }
        #pause-overlay .ps-logo { max-width: 80vw; } 
        #pause-overlay .ps-progress-meta { justify-content: center; text-align: center; width: 100%; }
        #pause-overlay .ps-progress-wrap { bottom: calc(6vh + env(safe-area-inset-bottom, 16px)); }
      }
      
      @media (orientation: portrait) and (max-width: 600px) {
        #pause-overlay .ps-layout, #pause-overlay .ps-progress-wrap { left: calc(${M.portraitPhone.left}vw + env(safe-area-inset-left, ${M.portraitPhone.left}vw)); right: calc(${M.portraitPhone.right}vw + env(safe-area-inset-right, ${M.portraitPhone.right}vw)); }
        #pause-overlay .ps-layout { top: calc(${M.portraitPhone.top}vh + env(safe-area-inset-top, ${M.portraitPhone.top}vh)); bottom: calc(${M.portraitPhone.bottom}vh + env(safe-area-inset-bottom, 16px)); gap: 1vh; }
        @supports (height: 100dvh) { #pause-overlay .ps-layout { top: calc(${M.portraitPhone.top}dvh + env(safe-area-inset-top, ${M.portraitPhone.top}dvh)); bottom: calc(${M.portraitPhone.bottom}dvh + env(safe-area-inset-bottom, 16px)); } }
        
        #pause-overlay .ps-logo { width: 100% !important; max-width: 100% !important; height: auto !important; max-height: 23vh !important; object-fit: contain !important; object-position: left center !important; margin: 0 0 1.5vh 0 !important; flex: 0 0 auto !important; }
        #pause-overlay .ps-title { font-size: ${F.phonePortrait.title}; margin-bottom: 0.7vh; letter-spacing: -0.02em; }
        #pause-overlay .ps-episode { font-size: ${F.phonePortrait.episode}; margin-bottom: 0.7vh; font-weight: 500; }
        #pause-overlay .ps-meta { font-size: ${F.phonePortrait.meta}; gap: 2vw; }
        #pause-overlay .ps-rating-badge { font-size: ${F.phonePortrait.ratingBadge}; padding: 0.25vh 1.2vw; }
        #pause-overlay .ps-divider { margin: 2vh 0; width: 36px; }
        #pause-overlay .ps-synopsis { font-size: ${F.phonePortrait.synopsis}; line-height: 1.45; }
        #pause-overlay .ps-progress-wrap { bottom: calc(5vh + env(safe-area-inset-bottom, 16px)); }
        @supports (height: 100dvh) { #pause-overlay .ps-progress-wrap { bottom: calc(5dvh + env(safe-area-inset-bottom, 16px)); } }
        #pause-overlay .ps-progress-meta { font-size: ${F.phonePortrait.progressMeta}; }
      }
      @media (orientation: portrait) and (min-width: 601px) and (max-width: 1024px) {
        #pause-overlay .ps-layout, #pause-overlay .ps-progress-wrap { left: calc(${M.portraitTablet.left}vw + env(safe-area-inset-left, 10px)); right: calc(${M.portraitTablet.right}vw + env(safe-area-inset-right, 10px)); }
        #pause-overlay .ps-title { font-size: ${F.tabletPortrait.title}; }
        #pause-overlay .ps-episode { font-size: ${F.tabletPortrait.episode}; }
        #pause-overlay .ps-meta { font-size: ${F.tabletPortrait.meta}; }
        #pause-overlay .ps-rating-badge { font-size: ${F.tabletPortrait.ratingBadge}; padding: 0.25vh 1vw; }
        #pause-overlay .ps-synopsis { font-size: ${F.tabletPortrait.synopsis}; }
        #pause-overlay .ps-progress-meta { font-size: ${F.tabletPortrait.progressMeta}; }
      }
      @media (orientation: landscape) and (max-height: 500px) {
        #pause-overlay .ps-layout, #pause-overlay .ps-progress-wrap { left: calc(${M.landscapePhone.left}vw + env(safe-area-inset-left, ${M.landscapePhone.left}vw)); right: calc(${M.landscapePhone.right}vw + env(safe-area-inset-right, ${M.landscapePhone.right}vw)); }
        #pause-overlay .ps-layout { top: ${M.landscapePhone.top}vh; bottom: calc(${M.landscapePhone.bottom}vh + env(safe-area-inset-bottom, 16px)); gap: 3vw; }
        #pause-overlay .ps-left { flex: 1.2; min-height: 0; overflow: hidden; }
        #pause-overlay .ps-right { flex: 0.8; margin: 2.5vh 0 2.5vh 2.5vw; }
        #pause-overlay .ps-right.ps-no-disc { display: none; }
        #pause-overlay .ps-title { font-size: ${F.phoneLandscape.title}; }
        #pause-overlay .ps-episode { font-size: ${F.phoneLandscape.episode}; }
        #pause-overlay .ps-meta { font-size: ${F.phoneLandscape.meta}; }
        #pause-overlay .ps-rating-badge { font-size: ${F.phoneLandscape.ratingBadge}; padding: 1px 4px; }
        #pause-overlay .ps-divider { margin: 2.5vh 0; }
        #pause-overlay .ps-synopsis { font-size: ${F.phoneLandscape.synopsis}; }
        #pause-overlay .ps-disc { width: 100%; height: auto; aspect-ratio: 1 / 1; }
        #pause-overlay .ps-progress-wrap { bottom: calc(4vh + env(safe-area-inset-bottom, 16px)); }
        #pause-overlay .ps-progress-meta { font-size: ${F.phoneLandscape.progressMeta}; }
      }
      @media (orientation: landscape) and (min-height: 501px) and (pointer: coarse) {
        #pause-overlay .ps-layout, #pause-overlay .ps-progress-wrap { left: calc(${M.landscapeTablet.left}vw + env(safe-area-inset-left, ${M.landscapeTablet.left}vw)); right: calc(${M.landscapeTablet.right}vw + env(safe-area-inset-right, ${M.landscapeTablet.right}vw)); }
        #pause-overlay .ps-layout { top: ${M.landscapeTablet.top}vh; bottom: calc(${M.landscapeTablet.bottom}vh + env(safe-area-inset-bottom, 16px)); gap: 5vw; }
        #pause-overlay .ps-left { flex: 1.5; min-height: 0; overflow: hidden; }
        #pause-overlay .ps-right { flex: 1; }
        #pause-overlay .ps-right.ps-no-disc { display: none; }
        #pause-overlay .ps-title { font-size: ${F.tabletLandscape.title}; }
        #pause-overlay .ps-episode { font-size: ${F.tabletLandscape.episode}; }
        #pause-overlay .ps-meta { font-size: ${F.tabletLandscape.meta}; gap: 0.6vw; }
        #pause-overlay .ps-rating-badge { font-size: ${F.tabletLandscape.ratingBadge}; padding: 0.2vh 0.6vw; }
        #pause-overlay .ps-synopsis { font-size: ${F.tabletLandscape.synopsis}; line-height: 1.5; }
        #pause-overlay .ps-disc { width: 100%; height: auto; aspect-ratio: 1 / 1; }
        #pause-overlay .ps-progress-wrap { bottom: calc(6vh + env(safe-area-inset-bottom, 16px)); }
        #pause-overlay .ps-progress-meta { font-size: ${F.tabletLandscape.progressMeta}; }
      }
      @media (min-width: 2000px) {
        #pause-overlay .ps-disc { max-width: ${F.largeScreen.discMaxSize}; max-height: ${F.largeScreen.discMaxSize}; }
        #pause-overlay .ps-title { font-size: ${F.largeScreen.title}; }
        #pause-overlay .ps-synopsis { font-size: ${F.largeScreen.synopsis}; }
      }
    `;
    document.head.appendChild(styleEl);
  }

  const overlay = document.createElement('div'); overlay.id = 'pause-overlay';
  overlay.style.cssText = `display: none; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; opacity: 0; touch-action: manipulation;`;
  overlay.style.setProperty('transition', 'opacity 0.35s ease', 'important');
  overlay.style.setProperty('--disc-spin-speed', `${CONFIG.discSpinSeconds}s`);
  
  overlay.innerHTML = `
    <div class="ps-backdrop-bg"></div>
    <div class="ps-backdrop-fg"></div>
    <div class="ps-vignette"></div>
    <div class="ps-layout">
      <div class="ps-left">
        <img class="ps-logo" />
        <div class="ps-title"></div>
        <div class="ps-episode"></div>
        <div class="ps-meta">
          <span class="ps-year"></span>
          <span class="ps-rating-badge"></span>
          <span class="ps-runtime"></span>
          <span class="ps-genres"></span>
          <span class="ps-star"></span>
        </div>
        <div class="ps-divider"></div>
        <div class="ps-synopsis"></div>
      </div>
      <div class="ps-right">
        <img class="ps-disc" data-has-disc="false" />
      </div>
    </div>
    <div class="ps-progress-wrap">
      <div class="ps-progress-track"><div class="ps-progress-fill"></div></div>
      <div class="ps-progress-meta">
        <span class="ps-progress-time"></span><span>•</span><span class="ps-progress-pct"></span><span>•</span><span class="ps-progress-end"></span>
      </div>
    </div>
    <div class="ps-close-btn">&#10005;</div>
  `;
  document.body.appendChild(overlay);

  const bgBackdropEl = overlay.querySelector('.ps-backdrop-bg');
  const fgBackdropEl = overlay.querySelector('.ps-backdrop-fg');
  const logoEl = overlay.querySelector('.ps-logo');
  const titleEl = overlay.querySelector('.ps-title');
  const episodeEl = overlay.querySelector('.ps-episode');
  const metaYear = overlay.querySelector('.ps-year');
  const metaRating = overlay.querySelector('.ps-rating-badge');
  const metaRuntime = overlay.querySelector('.ps-runtime');
  const metaGenres = overlay.querySelector('.ps-genres');
  const metaStar = overlay.querySelector('.ps-star');
  const synopsisEl = overlay.querySelector('.ps-synopsis');
  const rightCol = overlay.querySelector('.ps-right');
  const discEl = overlay.querySelector('.ps-disc');
  const progressFill = overlay.querySelector('.ps-progress-fill');
  const progressTime = overlay.querySelector('.ps-progress-time');
  const progressPct = overlay.querySelector('.ps-progress-pct');
  const progressEnd = overlay.querySelector('.ps-progress-end');

  // ── EVENT LISTENERS: Swipe, Scroll & Touch ──
  synopsisEl.addEventListener('touchstart', () => {
    isFingerDown = true;
    isUserScrolling = true;
    clearTimeout(userScrollTimeout);
  }, { passive: true });

  const checkScrollEnd = () => {
    clearTimeout(userScrollTimeout);
    if (isFingerDown) return; 
    
    userScrollTimeout = setTimeout(() => {
      isUserScrolling = false;
      lastFrameTime = performance.now();
    }, 150); 
  };

  synopsisEl.addEventListener('touchend', () => { isFingerDown = false; checkScrollEnd(); }, { passive: true });
  synopsisEl.addEventListener('touchcancel', () => { isFingerDown = false; checkScrollEnd(); }, { passive: true });
  
  synopsisEl.addEventListener('scroll', () => { 
    if (isUserScrolling || isFingerDown) {
      if (!isFingerDown) checkScrollEnd();
    } else {
      if (Math.abs(synopsisEl.scrollTop - currentScrollY) > 2.0) {
        isUserScrolling = true;
        checkScrollEnd();
      }
    }
  }, { passive: true });
  
  synopsisEl.addEventListener('wheel', () => { 
    isUserScrolling = true; 
    checkScrollEnd(); 
  }, { passive: true });

  const closeBtn = overlay.querySelector('.ps-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('touchend', (e) => {
      e.preventDefault(); 
      e.stopPropagation();
      triggerDismiss();
    }, { passive: false });
  }

  function onOverlayTouchStart(e) { touchStartX = e.touches[0].clientX; touchStartY = e.touches[0].clientY; }
  function onOverlayTouchEnd(e) {
    if (!touchResumeReady || !video?.paused || isDismissed) return;
    const dx = Math.abs(e.changedTouches[0].clientX - touchStartX);
    const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
    if (dx > CONFIG.dragThresholdPx || dy > CONFIG.dragThresholdPx) return;
    
    e.preventDefault();
    e.stopPropagation(); 
    video.play().catch(() => {});
  }

  overlay.addEventListener('touchstart', onOverlayTouchStart, { passive: true });
  overlay.addEventListener('touchend', onOverlayTouchEnd, { passive: false });
  overlay.addEventListener('click', (e) => {
    if (e.target.closest('.ps-close-btn')) { 
      triggerDismiss();
    } else {
      e.preventDefault(); e.stopPropagation(); 
    }
  });

  const existingVideo = document.querySelector('.videoPlayerContainer video');
  if (existingVideo) bindVideo(existingVideo);

  // ── CLEANUP & TEARDOWN ──
  function destroy() {
    purge(); unbindVideo(); if (resizeObserver) resizeObserver.disconnect();
    clearTimeout(mouseTimer); clearTimeout(touchReadyTimer); clearTimeout(resizeDebounce); clearTimeout(pauseShowTimer); clearTimeout(dismissTimer); clearTimeout(userScrollTimeout);
    window.removeEventListener('orientationchange', onOrientationChange); window.removeEventListener('resize', onOrientationChange); document.removeEventListener('pointermove', onPointerMove); document.removeEventListener('touchstart', handleDismissTouch);
    overlay.removeEventListener('touchstart', onOverlayTouchStart); overlay.removeEventListener('touchend', onOverlayTouchEnd);
    
    if (currentCroppedLogoUrl) URL.revokeObjectURL(currentCroppedLogoUrl);
    imgBlobCache.clear(); itemCache.clear(); overlay.remove();

    const styleTag = document.getElementById('pause-overlay-style');
    if (styleTag) styleTag.remove(); 
  }
  return { destroy };
}
})();