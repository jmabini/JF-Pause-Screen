/**
 * MASTER CONTROL CONFIGURATION
 * Everything you need to tweak is right here.
 */
export const CONFIG = {
  version: '4.3.2',

  // UNIVERSAL PLAYER (Route C) — see MASTER_PLAN_V2_UNIVERSAL.md
  // Everything below ships DEFAULT OFF. Nothing changes on install: with these values a
  // browser executes exactly today's code path, and Desktop/Android behave exactly as
  // they do today. Flip them only after the §6 device probe.
  enableUniversalPlayer: true,   // Capture layer + player façade (Desktop mpv, and any
                                  // future player with no <video>). false = never wrap
                                  // Events.trigger, never build a façade.
                                  // Runtime overrides, in priority order:
                                  //   window.__PS_DISABLE = true
                                  //   localStorage['jfPauseScreenDisableUniversal'] = '1'
                                  //   3 caught throws (automatic, per session)

  // Android only. Vetoes the ExoPlayer plugin instance so getPlayer() falls through to
  // htmlVideoPlayer, which builds a real <video> and puts Android back on today's path.
  //   'never'  — no veto at all. THIS RELEASE'S DEFAULT: nothing may change on install.
  //   'auto'   — RECOMMENDED PRODUCTION VALUE per §3. Veto only when the WebView would
  //              direct-play the item anyway (decided synchronously from
  //              item.MediaSources[0]), so the overlay costs zero playback capability.
  //   'always' — literal 100% coverage, at a transcoding cost: MKV, AC3 and probably
  //              HEVC fall back to server remux/transcode, with higher battery use and
  //              no native HDR/passthrough.
  // A `playbackerror` auto-suspends the veto for that item in every mode (§3).
  androidForceWebPlayer: 'auto',
  androidVetoExternalPlayer: false, // Also veto the "External player" plugin instance
                                    // (window.ExtPlayer, priority -2 — it sorts AHEAD of
                                    // ExoPlayer). Opt-in per §2.

  // GENERAL
  mouseHideDelay: 500,            // Time (ms) after pause to auto-hide mouse
  mouseShowDelay: 2000,           // Time (ms) after movement to show mouse again
  prefetchDelayMs: 1000,          // Delay (ms) before fetching metadata to allow native OSD to load

  // KEYBOARD SEEK
  keyboardSeekSeconds: 10,        // Seconds to seek forward/back on arrow key press

  // IDLE SCREENSAVER
  idleAutoDismissMs: 300000,      // Time (ms) idle before entering screensaver mode (default: 10 min)
  idleLogoSpeedPx: 80,            // Logo bounce speed at full ramp (px/s)
  idleLogoRampMs: 30000,          // Time (ms) to ramp from near-zero to full speed
  idleLogoScaleMax: 1.5,          // Max scale for the logo in screensaver mode
  idleLogoScaleRampMs: 60000,     // Time (ms) to reach max scale

  // TEXT MEASUREMENT
  measureScale: 1,                // Canvas scale multiplier for text measurement (1=normal, 2=hi-DPI precision)

  // THEME CONTRAST
  themeContrastMinLuminance: 0.12, // Minimum WCAG relative luminance for progress bar (0-1)

  // DYNAMIC THEME
  enableThemeColor: true,         // Toggle dominant color extraction for the progress bar
  themeBrightnessBoost: 0.25,     // Increases lightness of theme color (0.0 to 1.0)
  themeSaturationBoost: 0.65,     // Increases saturation of theme color (0.0 to 1.0)

  // BACKDROP
  backdropBrightness: 0.60,       // Background image brightness (0.0 = black, 1.0 = original)
  vignetteOpacity: 0.6,           // Vignette edge darkness (0.0 = none, 1.0 = solid black)
  backdropCycleRestMs: 30000,     // How long (ms) to show each backdrop before cycling
  backdropFadeMs: 2000,           // Duration (ms) of the cross-fade between backdrops
  preBlurSize: 128,               // Resolution (px) of low-res blur (performance optimization)
  preBlurPasses: 3,               // Blur strength (more passes = smoother, 3-5 is ideal)
  preBlurRadius: 20,              // Blur radius (px) for native canvas filter (10-40 range, higher = softer)

  // BACKDROP DELIVERY SIZE (server-side resize; backdrops are the bulk of network use)
  backdropSizing: true,           // Ask the server for a backdrop matched to the player, not the original
  backdropQuality: 90,            // Do NOT lower this. Jellyfin treats quality >= 90 as "default", so a
                                  // request at/above the source width passes through untouched. At 89 or
                                  // below, EVERY image forces a server-side decode+re-encode and a new
                                  // 30-day cache file, including ones that needed no resizing at all.
  backdropQuantizePx: 160,        // Round the requested width up to this step (stable cache keys while resizing)
  backdropMaxWidthPx: 3840,       // Never request wider than this, whatever the display reports (4K cap)
  backdropMaxDpr: 1.5,            // Pixel-density cap. This is the one knob that decides whether hi-DPI
                                  // screens save anything: at 2.0 a retina laptop, iPad or phone asks for
                                  // >= its source width and saves nothing. At 1.5 every display still gets
                                  // 1.5x its own pixels, on a backdrop dimmed to backdropBrightness and
                                  // vignetted — the difference is not visible, the bytes are.
  backdropAspect: 16 / 9,         // Assumed backdrop aspect, used to size for CSS `cover` in portrait

  // TOUCH BEHAVIOUR  
  pauseShowDelayTouchMs: 3000,    // Touch only: after a screen TAP pauses, leave Jellyfin's controls
                                  // on screen this long before the overlay fades in. Pauses from the
                                  // OSD button, a media key or a desktop click show immediately.
  dragThresholdPx: 10,            // Pixels moved before considering it a swipe instead of a tap
  touchResumeDelayMs: 300,        // Delay (ms) before allowing resume after interaction
  touchDismissRestoreMs: 5000,    // Time (ms) before auto-restoring UI after user dismissal

  // LOGO AUTO-CROP
  logoCropPaddingPx: 4,           // Extra margin (px) around cropped logos
  logoCropAlphaThreshold: 10,     // 0-255: Minimum opacity to consider as 'visible' pixel
  logoCropScanStep: 6,            // 1-16: Pixels skipped during scan (higher = faster, lower = accurate)

  // DISC IMAGE & CACHE
  discSpinSeconds: 60,            // Duration (s) for a full 360 degree rotation
  blobCacheMaxSize: 20,           // Max number of processed images to keep in memory

  pauseBadge: {
    frostBlurPx: 4,
    glassTint: 0.05,
    glassBrightness: 1,
    glassSaturation: 1,
    borderOpacity: 0.5,
    rimHighlightOpacity: 0.5,
    lightAngleDeg: 135,
    lightIntensity: 0.15,
    splayPct: 55,
    fontOpacity: 0.5,
    trackingEm: 0.05,
    fontWeight: 400,
    fontSizeOffsetPx: -4,
    landscapeTopPct: 50,
    landscapeWidthPctOfDisc: 40,
    landscapeHeightPctOfDisc: 10,
    portraitPhoneWidthPct: 36,
    portraitPhoneHeightPctOfVW: 10.7,
    portraitTabletWidthPct: 24,
    portraitTabletHeightPctOfVW: 7.1,
    innerGlowTLOpacity: 0.35,
    innerGlowTLBlur: 12,
    innerGlowTLSpread: 6,
    innerGlowTLOffsetX: -6,
    innerGlowTLOffsetY: -4,
    innerGlowBROpacity: 0.18,
    innerGlowBRBlur: 12,
    innerGlowBRSpread: 2,
    innerGlowBROffsetX: 3,
    innerGlowBROffsetY: 3,
  },

  // LAYOUT
  genresMaxPhonePortrait: 1,      // Max genres shown on small mobile screens
  genresMaxDefault: 5,            // Max genres shown on tablets/desktop
  enableTextShadow: true,         // Toggle the global text dropshadow
  textShadowDefinition: "0 2px 4px rgba(0,0,0,0.7), 0 0 16px rgba(0,0,0,0.75)", // CSS shadow syntax
  landscapeColumns: {
    left: 5.25,                   // Relative width of the landscape text/logo column
    right: 2.55,                  // Relative width of the landscape disc column
  },

  // FONT SIZES (Using Viewport Width 'vw' for fluid scaling)
  fonts: {
    desktop: {
      title: '3.4vw',
      episode: '1.7vw',
      meta: '1.1vw',
      ratingBadge: '0.95vw',
      synopsis: '2vw',
      progressMeta: '1vw',
    },
    phonePortrait: {
      title: '8.5vw',
      episode: '5vw',
      meta: '3.8vw',
      ratingBadge: '3vw',
      synopsis: '6.0vw',
      progressMeta: '3.5vw',
    },
    tabletPortrait: {
      title: '5.5vw',
      episode: '3vw',
      meta: '2.2vw',
      ratingBadge: '1.8vw',
      synopsis: '4vw',
      progressMeta: '2vw',
    },
    phoneLandscape: {
      title: '3.5vw',
      episode: '2.2vw',
      meta: '1.6vw',
      ratingBadge: '1.3vw',
      synopsis: '2.9vw',
      progressMeta: '1.4vw',
    },
    tabletLandscape: {
      title: '3.8vw',
      episode: '2vw',
      meta: '1.4vw',
      ratingBadge: '1.1vw',
      synopsis: '3vw',
      progressMeta: '1.2vw',
    },
    largeScreen: {
      title: '2.6vw',
      synopsis: '2vw',
    },
  },

  // SYNOPSIS SCROLLING
  synopsis: {
    minDefault: 26,               // Minimum font size (px) for auto-sizing
    minLargeScreen: 36,
    minTabletLandscape: 22,
    minTabletPortrait: 22,
    minPhonePortrait: 18,
    minPhoneLandscape: 18,
    descenderGuardPx: 24,         // Extra space (px) at bottom to prevent letter clipping

    scroll: {
      linesPerSecond: 0.13,        // Speed of the auto-scroll
      initialHoldMs: 10000,        // Time (ms) to wait before starting to scroll
      scrollRampMs: 800,          // Duration (ms) of the acceleration phase
      scrollResumeRampMs: 2000,   // Time (ms) to return to auto-scroll after manual touch
    },
  },

  // MARGINS (Using Viewport Units 'vh'/'vw')
  margins: {
    desktop: { top: 8, left: 8, right: 8, bottom: 16 },
    portraitPhone: { top: 7.2, left: 6, right: 6, bottom: 8 },
    portraitTablet: { top: 6, left: 10, right: 10, bottom: 14 },
    landscapePhone: { top: 3.5, left: 7, right: 7, bottom: 11 },
    landscapeTablet: { top: 6, left: 8, right: 8, bottom: 16 },
    largeScreen: { top: 8, left: 8, right: 8, bottom: 16 },
  },
};
