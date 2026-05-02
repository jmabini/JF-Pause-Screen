/**
 * MASTER CONTROL CONFIGURATION
 * Everything you need to tweak is right here.
 */
export const CONFIG = {
  version: '3.8.0',

  // GENERAL
  mouseHideDelay: 500,            // Time (ms) after pause to auto-hide mouse
  mouseShowDelay: 1000,           // Time (ms) after movement to show mouse again
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
  themeContrastMinLuminance: 0.12, // Minimum WCAG relative luminance for divider/progress bar (0–1)

  // DYNAMIC THEME & DROPSHADOW
  enableThemeColor: true,         // Toggle dominant color extraction for UI elements
  themeBrightnessBoost: 0.25,     // Increases lightness of theme color (0.0 to 1.0)
  themeSaturationBoost: 0.75,     // Increases saturation of theme color (0.0 to 1.0)
  enableDynamicDropshadow: true,  // Toggle dropshadow based on background dominant color
  dropshadowExposureAmount: 0.7,  // Multiplier for shadow brightness (0.0 = black, 1.0 = original color)
  dropshadowAlpha: 1,             // Shadow opacity (0.0 = invisible, 1.0 = fully opaque)

  // BACKDROP
  backdropBrightness: 0.60,       // Background image brightness (0.0 = black, 1.0 = original)
  vignetteOpacity: 0.6,          // Vignette edge darkness (0.0 = none, 1.0 = solid black)
  backdropCycleRestMs: 30000,     // How long (ms) to show each backdrop before cycling
  backdropFadeMs: 2000,           // Duration (ms) of the cross-fade between backdrops
  preBlurSize: 128,               // Resolution (px) of low-res blur (performance optimization)
  preBlurPasses: 3,               // Blur strength (more passes = smoother, 3-5 is ideal)
  preBlurRadius: 20,              // Blur radius (px) for native canvas filter (10-40 range, higher = softer)

  // TOUCH BEHAVIOUR  
  pauseShowDelayTouchMs: 0,       // Extra delay (ms) for touch devices
  dragThresholdPx: 10,            // Pixels moved before considering it a swipe instead of a tap
  touchResumeDelayMs: 300,        // Delay (ms) before allowing resume after interaction
  touchDismissRestoreMs: 5000,    // Time (ms) before auto-restoring UI after user dismissal

  // LOGO AUTO-CROP
  logoCropPaddingPx: 4,           // Extra margin (px) around cropped logos
  logoCropAlphaThreshold: 10,     // 0-255: Minimum opacity to consider as 'visible' pixel
  logoCropScanStep: 2,            // 1-16: Pixels skipped during scan (higher = faster, lower = accurate)

  // DISC IMAGE & CACHE
  discSpinSeconds: 60,            // Duration (s) for a full 360 degree rotation
  blobCacheMaxSize: 20,           // Max number of processed images to keep in memory

  // LAYOUT
  genresMaxPhonePortrait: 1,      // Max genres shown on small mobile screens
  genresMaxDefault: 5,            // Max genres shown on tablets/desktop
  enableTextShadow: true,         // Toggle the global text dropshadow
  textShadowDefinition: "0 2px 4px rgba(0,0,0,0.6), 0 0 15px var(--theme-drop-shadow, rgba(0,0,0,1)), 0 0 40px var(--theme-drop-shadow, rgba(0,0,0,0.7))", // CSS shadow syntax
  landscapeColumns: {
    left: 5.45,                   // Relative width of the landscape text/logo column
    right: 2.55,                  // Relative width of the landscape disc column
  },

  // FONT SIZES (Using Viewport Width 'vw' for fluid scaling)
  fonts: {
    desktop: {
      title: '3.4vw',
      episode: '1.7vw',
      meta: '1.1vw',
      ratingBadge: '0.95vw',
      synopsis: '2.2vw',
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
      synopsis: '4.2vw',
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
      synopsis: '3.2vw',
      progressMeta: '1.2vw',
    },
    largeScreen: {
      title: '2.6vw',
      synopsis: '2.1vw',
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
      linesPerSecond: 0.2,        // Speed of the auto-scroll
      initialHoldMs: 5000,        // Time (ms) to wait before starting to scroll
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
