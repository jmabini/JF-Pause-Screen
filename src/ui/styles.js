import { CONFIG } from '../config.js';

// Ensure viewport-fit=cover so env(safe-area-inset-*) returns real device insets
(function ensureViewportFitCover() {
  let meta = document.querySelector('meta[name="viewport"]');
  if (meta) {
    const content = meta.getAttribute('content') || '';
    if (!/viewport-fit\s*=/.test(content)) {
      meta.setAttribute('content', content + ', viewport-fit=cover');
    }
  } else {
    meta = document.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
    document.head.appendChild(meta);
  }
})();

export function getStyles() {
  const F = CONFIG.fonts, M = CONFIG.margins, LC = CONFIG.landscapeColumns;
  const TS = `text-shadow: ${CONFIG.enableTextShadow ? CONFIG.textShadowDefinition : 'none'};`;

  return `
  @keyframes ps-spin-ls { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { #pause-overlay .ps-disc { animation: none !important; } }
  #pause-overlay *::-webkit-scrollbar { display: none; } #pause-overlay * { box-sizing: border-box; }
  
  #pause-overlay .ps-backdrop-bg, #pause-overlay .ps-backdrop-fg { position: absolute; inset: 0; background-color: #000; background-size: cover; background-position: center; filter: brightness(${CONFIG.backdropBrightness}); transform: translateZ(0); will-change: opacity, filter, transform; }
  #pause-overlay .ps-backdrop-fg { opacity: 0; }
  #pause-overlay .ps-backdrop-bg.ps-blurred, #pause-overlay .ps-backdrop-fg.ps-blurred { filter: brightness(${CONFIG.backdropBrightness}) blur(25px); transform: scale(1.2); }
  
  #pause-overlay .ps-vignette { position: absolute; inset: 0; background: radial-gradient(ellipse at center, transparent 0%, rgba(0,0,0,${CONFIG.vignetteOpacity}) 100%); pointer-events: none; }
  #pause-overlay .ps-layout { position: absolute; top: ${M.desktop.top}vh; left: ${M.desktop.left}vw; right: ${M.desktop.right}vw; bottom: calc(${M.desktop.bottom}vh + env(safe-area-inset-bottom, 0px)); display: flex; gap: 6vw; flex-direction: row; }
  @supports (height: 100dvh) { #pause-overlay .ps-layout { top: ${M.largeScreen.top}dvh; bottom: calc(${M.largeScreen.bottom}dvh + env(safe-area-inset-bottom, 0px)); } }
  
  #pause-overlay .ps-left { flex: 7; display: flex; flex-direction: column; justify-content: center; overflow: visible; color: white; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; min-height: 0; height: 100%; }
  #pause-overlay .ps-right { flex: 3; display: flex; justify-content: center; align-items: center; position: relative; }
  
  #pause-overlay .ps-logo { display: none; max-width: 30vw; height: auto; max-height: clamp(100px, 18vh, 240px); object-fit: contain; object-position: left; margin-bottom: 2vh; flex-shrink: 0; }
  
  #pause-overlay .ps-title { display: none; font-size: ${F.desktop.title}; font-weight: 700; line-height: 1.05; letter-spacing: -0.01em; color: white; ${TS} margin-bottom: 1.2vh; flex-shrink: 0; padding: 4px; margin-left: -4px; margin-top: -4px; overflow-wrap: anywhere; word-break: break-word; }
  #pause-overlay .ps-episode { display: none; font-size: ${F.desktop.episode}; font-weight: 600; letter-spacing: 0.01em; color: rgba(255,255,255,0.85); ${TS} margin-bottom: 1.2vh; flex-shrink: 0; padding: 4px; margin-left: -4px; margin-top: -4px; overflow-wrap: anywhere; word-break: break-word; }
  #pause-overlay .ps-meta { display: flex; align-items: center; gap: 1vw; flex-wrap: nowrap; margin-bottom: 0; flex-shrink: 0; font-size: ${F.desktop.meta}; color: rgba(255,255,255,0.65); letter-spacing: 0.015em; ${TS} width: 100%; min-width: 0; padding: 4px; margin-left: -4px; margin-top: -4px; white-space: nowrap; }
  #pause-overlay .ps-meta > span { white-space: nowrap; flex-shrink: 1; min-width: 0; } 
  #pause-overlay .ps-meta .ps-genres { overflow: hidden; text-overflow: ellipsis; flex-shrink: 3; padding: 10px 0; margin: -10px 0; }
  #pause-overlay .ps-rating-badge { border: 1px solid rgba(255,255,255,0.4); border-radius: 2px; flex-shrink: 0; font-weight: 500; font-size: ${F.desktop.ratingBadge}; padding: 0.15vh 0.5vw; }
  
  #pause-overlay .ps-divider { width: 40px; height: 1.5px; background: var(--theme-color, rgba(255,255,255,0.3)); box-shadow: 0 0 20px var(--theme-glow, transparent), 0 0 40px var(--theme-glow, transparent); margin: 2vh 0; flex-shrink: 0; border-radius: 1px; transition: background-color 2s ease, box-shadow 2s ease; }
  
  #pause-overlay .ps-synopsis { padding: 0 20px; margin: 0 -20px; font-size: ${F.desktop.synopsis}; line-height: 1.5; color: rgba(255,255,255,0.92); flex: 0 1 auto; min-height: 0; max-height: 100%; ${TS} position: relative; overflow: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; -ms-overflow-style: none; touch-action: pan-y; overflow-wrap: anywhere; word-break: break-word; }
  
  #pause-overlay .ps-disc { display: none; width: 100%; max-height: 100%; height: auto; aspect-ratio: 1 / 1; object-fit: contain; border-radius: 50%; animation: ps-spin-ls var(--disc-spin-speed, 60s) linear infinite; filter: brightness(0.85) drop-shadow(0 8px 16px rgba(0,0,0,0.4)) drop-shadow(0 0 80px var(--theme-glow-raw, transparent)); transition: filter 2s ease; }
  @media (orientation: landscape) { #pause-overlay .ps-disc { display: block; } } @media (orientation: portrait) { #pause-overlay .ps-disc { display: none !important; } }
  
  #pause-overlay .ps-progress-wrap { position: absolute; bottom: calc(7vh + env(safe-area-inset-bottom, 0px)); left: ${M.desktop.left}vw; right: ${M.desktop.right}vw; }
  @supports (height: 100dvh) { #pause-overlay .ps-progress-wrap { bottom: calc(7dvh + env(safe-area-inset-bottom, 0px)); } }
  #pause-overlay .ps-progress-track { position: relative; width: 100%; height: 4px; background: rgba(255,255,255,0.2); border-radius: 2px; margin-bottom: 1vh; }
  #pause-overlay .ps-progress-fill { height: 100%; background: var(--theme-progress, rgba(255,255,255,0.9)); border-radius: 2px; width: 0%; transition: width 0.25s ease, background-color 2s ease; }
  #pause-overlay .ps-progress-meta { display: flex; gap: 0.8vw; align-items: center; font-family: inherit; font-size: ${F.desktop.progressMeta}; color: rgba(255,255,255,0.65); ${TS} }

  #pause-overlay .ps-close-btn { position: absolute; top: max(2vh, env(safe-area-inset-top, 0px)); right: max(3vw, env(safe-area-inset-right, 0px)); width: 44px; height: 44px; background: rgba(0,0,0,0.3); border: 1.5px solid rgba(255,255,255,0.4); border-radius: 50%; color: rgba(255,255,255,0.85); font-size: 20px; display: flex; justify-content: center; align-items: center; z-index: 2147483647; pointer-events: auto; backdrop-filter: blur(4px); font-family: sans-serif; font-weight: 300; touch-action: manipulation; }
  @media (pointer: fine) { #pause-overlay .ps-close-btn { display: none !important; } } 

  @media (orientation: portrait) {
    #pause-overlay .ps-layout { flex-direction: column; gap: 2.5vh; top: calc(${M.portraitTablet.top}vh + env(safe-area-inset-top, 0px)); bottom: calc(${M.portraitTablet.bottom}vh + env(safe-area-inset-bottom, 0px)); }
    @supports (height: 100dvh) { #pause-overlay .ps-layout { top: calc(${M.portraitTablet.top}dvh + env(safe-area-inset-top, 0px)); bottom: calc(${M.portraitTablet.bottom}dvh + env(safe-area-inset-bottom, 0px)); } }
    #pause-overlay .ps-right { display: none !important; position: absolute; visibility: hidden; }
    #pause-overlay .ps-left { flex: 1; min-height: 0; height: 100%; justify-content: flex-start; }
    #pause-overlay .ps-logo { max-width: 80vw; } 
    #pause-overlay .ps-progress-meta { justify-content: center; text-align: center; width: 100%; }
    #pause-overlay .ps-progress-wrap { bottom: calc(6vh + env(safe-area-inset-bottom, 0px)); }
  }
  
  @media (orientation: portrait) and (max-width: 600px) {
    #pause-overlay .ps-layout, #pause-overlay .ps-progress-wrap { left: calc(${M.portraitPhone.left}vw + env(safe-area-inset-left, 0px)); right: calc(${M.portraitPhone.right}vw + env(safe-area-inset-right, 0px)); }
    #pause-overlay .ps-layout { top: calc(${M.portraitPhone.top}vh + env(safe-area-inset-top, 0px)); bottom: calc(${M.portraitPhone.bottom}vh + env(safe-area-inset-bottom, 0px)); gap: 1vh; }
    @supports (height: 100dvh) { #pause-overlay .ps-layout { top: calc(${M.portraitPhone.top}dvh + env(safe-area-inset-top, 0px)); bottom: calc(${M.portraitPhone.bottom}dvh + env(safe-area-inset-bottom, 0px)); } }
    
    #pause-overlay .ps-logo { width: 100% !important; max-width: 100% !important; height: auto !important; max-height: 23vh !important; object-fit: contain !important; object-position: left center !important; margin: 0 0 1.5vh 0 !important; flex: 0 0 auto !important; }
    #pause-overlay .ps-title { font-size: ${F.phonePortrait.title}; margin-bottom: 0.7vh; letter-spacing: -0.02em; }
    #pause-overlay .ps-episode { font-size: ${F.phonePortrait.episode}; margin-bottom: 0.7vh; font-weight: 500; }
    #pause-overlay .ps-meta { font-size: ${F.phonePortrait.meta}; gap: 2vw; }
    #pause-overlay .ps-rating-badge { font-size: ${F.phonePortrait.ratingBadge}; padding: 0.25vh 1.2vw; }
    #pause-overlay .ps-divider { margin: 2vh 0; width: 36px; }
    #pause-overlay .ps-synopsis { font-size: ${F.phonePortrait.synopsis}; line-height: 1.45; }
    #pause-overlay .ps-progress-wrap { bottom: calc(5vh + env(safe-area-inset-bottom, 0px)); }
    @supports (height: 100dvh) { #pause-overlay .ps-progress-wrap { bottom: calc(5dvh + env(safe-area-inset-bottom, 0px)); } }
    #pause-overlay .ps-progress-meta { font-size: ${F.phonePortrait.progressMeta}; }
  }
  @media (orientation: portrait) and (min-width: 601px) and (max-width: 1024px) {
    #pause-overlay .ps-layout, #pause-overlay .ps-progress-wrap { left: calc(${M.portraitTablet.left}vw + env(safe-area-inset-left, 0px)); right: calc(${M.portraitTablet.right}vw + env(safe-area-inset-right, 0px)); }
    #pause-overlay .ps-title { font-size: ${F.tabletPortrait.title}; }
    #pause-overlay .ps-episode { font-size: ${F.tabletPortrait.episode}; }
    #pause-overlay .ps-meta { font-size: ${F.tabletPortrait.meta}; }
    #pause-overlay .ps-rating-badge { font-size: ${F.tabletPortrait.ratingBadge}; padding: 0.25vh 1vw; }
    #pause-overlay .ps-synopsis { font-size: ${F.tabletPortrait.synopsis}; }
    #pause-overlay .ps-progress-meta { font-size: ${F.tabletPortrait.progressMeta}; }
  }
  @media (orientation: landscape) and (max-height: 500px) {
    #pause-overlay .ps-layout, #pause-overlay .ps-progress-wrap { left: calc(${M.landscapePhone.left}vw + env(safe-area-inset-left, 0px)); right: calc(${M.landscapePhone.right}vw + env(safe-area-inset-right, 0px)); }
    #pause-overlay .ps-layout { top: ${M.landscapePhone.top}vh; bottom: calc(${M.landscapePhone.bottom}vh + env(safe-area-inset-bottom, 0px)); gap: 3vw; }
    #pause-overlay .ps-left { flex: 7; min-height: 0; overflow: hidden; }
    #pause-overlay .ps-right { flex: 3; margin: 2.5vh 0 2.5vh 2.5vw; }
    #pause-overlay .ps-title { font-size: ${F.phoneLandscape.title}; }
    #pause-overlay .ps-episode { font-size: ${F.phoneLandscape.episode}; }
    #pause-overlay .ps-meta { font-size: ${F.phoneLandscape.meta}; }
    #pause-overlay .ps-rating-badge { font-size: ${F.phoneLandscape.ratingBadge}; padding: 1px 4px; }
    #pause-overlay .ps-divider { margin: 2.5vh 0; }
    #pause-overlay .ps-synopsis { font-size: ${F.phoneLandscape.synopsis}; }
    #pause-overlay .ps-disc { width: 100%; height: auto; aspect-ratio: 1 / 1; }
    #pause-overlay .ps-progress-wrap { bottom: calc(4vh + env(safe-area-inset-bottom, 0px)); }
    #pause-overlay .ps-progress-meta { font-size: ${F.phoneLandscape.progressMeta}; }
  }
  @media (orientation: landscape) and (min-height: 501px) and (pointer: coarse) {
    #pause-overlay .ps-layout, #pause-overlay .ps-progress-wrap { left: calc(${M.landscapeTablet.left}vw + env(safe-area-inset-left, 0px)); right: calc(${M.landscapeTablet.right}vw + env(safe-area-inset-right, 0px)); }
    #pause-overlay .ps-layout { top: ${M.landscapeTablet.top}vh; bottom: calc(${M.landscapeTablet.bottom}vh + env(safe-area-inset-bottom, 0px)); gap: 5vw; }
    #pause-overlay .ps-left { flex: 7; min-height: 0; overflow: hidden; }
    #pause-overlay .ps-right { flex: 3; }
    #pause-overlay .ps-title { font-size: ${F.tabletLandscape.title}; }
    #pause-overlay .ps-episode { font-size: ${F.tabletLandscape.episode}; }
    #pause-overlay .ps-meta { font-size: ${F.tabletLandscape.meta}; gap: 0.6vw; }
    #pause-overlay .ps-rating-badge { font-size: ${F.tabletLandscape.ratingBadge}; padding: 0.2vh 0.6vw; }
    #pause-overlay .ps-synopsis { font-size: ${F.tabletLandscape.synopsis}; line-height: 1.5; }
    #pause-overlay .ps-disc { width: 100%; height: auto; aspect-ratio: 1 / 1; }
    #pause-overlay .ps-progress-wrap { bottom: calc(6vh + env(safe-area-inset-bottom, 0px)); }
    #pause-overlay .ps-progress-meta { font-size: ${F.tabletLandscape.progressMeta}; }
  }
  @media (orientation: landscape) {
    #pause-overlay .ps-layout { display: grid; grid-template-columns: minmax(0, ${LC.left}fr) minmax(0, ${LC.right}fr); gap: clamp(16px, 1.5vw, 32px); align-items: stretch; }
    #pause-overlay .ps-left { justify-content: flex-start; align-self: stretch; min-width: 0; overflow: hidden; }
    #pause-overlay .ps-right { display: flex; align-self: stretch; justify-content: center; align-items: center; margin: 0; min-width: 0; min-height: 0; overflow: visible; }
    #pause-overlay .ps-logo { align-self: flex-start; width: min(100%, 30vw); max-width: 100%; max-height: clamp(180px, 24vh, 340px); object-fit: contain; object-position: left top; margin: 0 0 1.5vh 0; }
    #pause-overlay .ps-synopsis { max-width: 100%; }
    #pause-overlay .ps-disc { width: 100%; max-width: 100%; height: auto; max-height: 100%; aspect-ratio: 1 / 1; object-position: center; }
  }
  @media (orientation: landscape) and (pointer: fine) {
    #pause-overlay .ps-layout { top: 6vh; bottom: calc(14vh + env(safe-area-inset-bottom, 0px)); }
    @supports (height: 100dvh) { #pause-overlay .ps-layout { top: 6dvh; bottom: calc(14dvh + env(safe-area-inset-bottom, 0px)); } }
  }

  /* CHAPTER TICKS */
  #pause-overlay .ps-chapter-ticks { position: absolute; top: 0; left: 0; right: 0; height: 100%; pointer-events: none; overflow: hidden; border-radius: 2px; }
  #pause-overlay .ps-chapter-tick { position: absolute; top: 0; width: 2px; height: 100%; background: rgba(255,255,255,0.55); border-radius: 1px; transform: translateX(-50%); transition: background-color 0.2s, filter 0.2s; }
  #pause-overlay .ps-chapter-tick.ps-past { background: var(--theme-color, rgba(255,255,255,0.55)); filter: brightness(0.5); }

  /* SCREENSAVER / IDLE MODE */
  #pause-overlay .ps-screensaver-logo { display: none; position: fixed; pointer-events: none; z-index: 2147483647; opacity: 0; transition: opacity 1.2s ease; left: 0; top: 0; will-change: transform; object-fit: contain; }
  #pause-overlay.ps-screensaver .ps-screensaver-logo { display: block; }
  #pause-overlay.ps-screensaver .ps-layout,
  #pause-overlay.ps-screensaver .ps-progress-wrap,
  #pause-overlay.ps-screensaver .ps-close-btn { opacity: 0; pointer-events: none; transition: opacity 1.5s ease; }
  `;
}
