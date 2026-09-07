/**
 * IMAGE & THEME SERVICES
 */
import { CONFIG } from '../config.js';
import { directorWorkerCode } from './directorWorker.js';

let directorWorker = null;
let requestCounter = 0;
const pendingRequests = new Map();

export function getDirectorWorker() {
  if (!directorWorker) {
    const blob = new Blob([directorWorkerCode], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    directorWorker = new Worker(workerUrl);
    URL.revokeObjectURL(workerUrl);
    directorWorker.onmessage = (e) => {
      const { id, status, result, error, fallback } = e.data;
      if (pendingRequests.has(id)) {
        const { resolve, reject } = pendingRequests.get(id);
        pendingRequests.delete(id);
        if (status === 'success') resolve(result);
        else {
          const err = new Error(error);
          err.fallback = fallback;
          reject(err);
        }
      }
    };
  }
  return directorWorker;
}

export function directorRequest(type, payload, signal) {
  return new Promise((resolve, reject) => {
    const id = ++requestCounter;
    const worker = getDirectorWorker();
    let cleanup = () => {};
    
    if (signal) {
      const onAbort = () => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          cleanup();
          reject(new DOMException('Aborted', 'AbortError'));
        }
      };
      cleanup = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    pendingRequests.set(id, {
      resolve: (value) => { cleanup(); resolve(value); },
      reject: (err) => { cleanup(); reject(err); }
    });
    worker.postMessage({ id, type, payload });
  });
}

function wcagLuminance(r, g, b) {
  // r, g, b in 0-1 range
  const toLinear = c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function hslToRgbNorm(h, s, l) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  return [hue2rgb(p, q, h + 1/3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1/3)];
}

export function applyThemeColor(overlay, rgbArray) {
  if (!rgbArray) {
    overlay.style.setProperty('--theme-progress', 'rgba(255,255,255,0.9)');
    return;
  }

  if (!CONFIG.enableThemeColor) {
    overlay.style.setProperty('--theme-progress', 'rgba(255,255,255,0.9)');
    return;
  }

  let [r, g, b] = rgbArray;
  r /= 255; g /= 255; b /= 255;
  let max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;

  if (max === min) { h = s = 0; }
  else {
    let d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }

  s = Math.min(1, s + (CONFIG.themeSaturationBoost ?? 0.30));
  l = Math.min(1, l + (CONFIG.themeBrightnessBoost ?? 0.30));

  let rNew, gNew, bNew;
  if (s === 0) {
    rNew = gNew = bNew = l;
  } else {
    let q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    let p = 2 * l - q;
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    rNew = hue2rgb(p, q, h + 1 / 3);
    gNew = hue2rgb(p, q, h);
    bNew = hue2rgb(p, q, h - 1 / 3);
  }

  // Analogous color fallback: if boosted color lacks contrast against dark backdrop,
  // try hue-shifted variants (±30°, ±60°) and pick the most luminous one.
  const minLum = CONFIG.themeContrastMinLuminance ?? 0.12;
  if (wcagLuminance(rNew, gNew, bNew) < minLum) {
    const offsets = [1/12, -1/12, 1/6, -1/6]; // ±30° and ±60° in 0-1 hue space
    let bestLum = wcagLuminance(rNew, gNew, bNew);
    for (const offset of offsets) {
      const ah = ((h + offset) % 1 + 1) % 1;
      const [ar, ag, ab] = hslToRgbNorm(ah, s, l);
      const aLum = wcagLuminance(ar, ag, ab);
      if (aLum > bestLum) { bestLum = aLum; rNew = ar; gNew = ag; bNew = ab; }
    }
  }

  const finalRgb = `rgb(${Math.round(rNew * 255)}, ${Math.round(gNew * 255)}, ${Math.round(bNew * 255)})`;
  overlay.style.setProperty('--theme-progress', finalRgb);
}

export function isPortrait() { return window.matchMedia('(orientation: portrait)').matches; }
export function isPhoneLandscape() { return window.matchMedia('(orientation: landscape) and (max-height: 500px)').matches; }
export function isPhonePortrait() { return isPortrait() && window.innerWidth <= 600; }
export function isTabletLandscape() { return window.matchMedia('(orientation: landscape) and (min-height: 501px) and (pointer: coarse)').matches; }

// Matches both Jellyfin's 32-char hex IDs and standard UUIDs (8-4-4-4-12)
const ITEM_ID_PATTERN = /[a-f0-9]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const STRICT_32_HEX = /^[a-f0-9]{32}$/i;
const STRICT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidItemId(id) {
  return id && (STRICT_32_HEX.test(id) || STRICT_UUID.test(id));
}

export function getItemId(video) {
  // Route C item-id override (MASTER_PLAN_V2_UNIVERSAL.md §1). The captured
  // `playbackstart` payload carries state.NowPlayingItem.Id directly — Live TV included —
  // which matters because mpv populates neither the <video> poster attribute nor the OSD
  // `data-id` buttons that the DOM derivation below scrapes. A raw <video> element has no
  // `psItemId`, so the browser path falls straight through, unchanged. The id is still
  // validated here, so a malformed payload cannot poison the request URL.
  const overrideId = video?.psItemId;
  if (isValidItemId(overrideId)) return overrideId;

  const candidates = [
    document.querySelector('.videoOsdBottom button[data-id]'),
    document.querySelector('.osdControls button[data-id]'),
    document.querySelector('.btnUserRating[data-id]'),
    document.querySelector('button[data-id][class*="Btn"]')
  ];
  for (const el of candidates) { 
    const id = el?.dataset?.id; 
    if (isValidItemId(id)) return id; 
  }

  const poster = video?.getAttribute('poster') || '';
  const fromPoster = poster.match(new RegExp('/Items/(' + ITEM_ID_PATTERN.source + ')/', 'i'))?.[1];
  if (fromPoster) return fromPoster;

  const hash = window.location.hash.toLowerCase();
  const search = window.location.search.toLowerCase();
  if (hash.includes('/video') || search.includes('/video')) {
    const idPattern = new RegExp('(?:id|itemId)=(' + ITEM_ID_PATTERN.source + ')', 'i');
    const hashMatch = window.location.hash.match(idPattern) || window.location.search.match(idPattern);
    if (hashMatch) return hashMatch[1];
  }

  return null;
}
