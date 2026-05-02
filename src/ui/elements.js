import { CONFIG } from '../config.js';

export function createOverlay() {
  const overlay = document.createElement('div');
  const pauseBadgeMode = CONFIG.pauseBadge?.glassMode === 'low' ? 'low' : 'balanced';
  overlay.id = 'pause-overlay';
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
        <div class="ps-paused-badge ps-paused-badge-landscape ps-paused-badge-glass-${pauseBadgeMode}" aria-hidden="true"><span class="ps-paused-badge-text">PAUSED</span></div>
      </div>
    </div>
    <div class="ps-paused-badge ps-paused-badge-portrait ps-paused-badge-glass-${pauseBadgeMode}" aria-hidden="true"><span class="ps-paused-badge-text">PAUSED</span></div>
    <div class="ps-progress-wrap">
      <div class="ps-progress-track"><div class="ps-progress-fill"></div><div class="ps-chapter-ticks"></div></div>
      <div class="ps-progress-meta">
        <span class="ps-progress-time"></span><span>•</span><span class="ps-progress-pct"></span><span>•</span><span class="ps-progress-end"></span>
      </div>
    </div>
    <div class="ps-close-btn">&#10005;</div>
    <img class="ps-screensaver-logo" />
  `;

  document.body.appendChild(overlay);

  return {
    overlay,
    bgBackdropEl: overlay.querySelector('.ps-backdrop-bg'),
    fgBackdropEl: overlay.querySelector('.ps-backdrop-fg'),
    logoEl: overlay.querySelector('.ps-logo'),
    titleEl: overlay.querySelector('.ps-title'),
    episodeEl: overlay.querySelector('.ps-episode'),
    metaYear: overlay.querySelector('.ps-year'),
    metaRating: overlay.querySelector('.ps-rating-badge'),
    metaRuntime: overlay.querySelector('.ps-runtime'),
    metaGenres: overlay.querySelector('.ps-genres'),
    metaStar: overlay.querySelector('.ps-star'),
    synopsisEl: overlay.querySelector('.ps-synopsis'),
    rightCol: overlay.querySelector('.ps-right'),
    discEl: overlay.querySelector('.ps-disc'),
    progressFill: overlay.querySelector('.ps-progress-fill'),
    progressTime: overlay.querySelector('.ps-progress-time'),
    progressPct: overlay.querySelector('.ps-progress-pct'),
    progressEnd: overlay.querySelector('.ps-progress-end'),
    chapterTicksEl: overlay.querySelector('.ps-chapter-ticks'),
    screensaverLogoEl: overlay.querySelector('.ps-screensaver-logo'),
    closeBtn: overlay.querySelector('.ps-close-btn')
  };
}
