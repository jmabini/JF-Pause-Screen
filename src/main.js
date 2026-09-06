import { CONFIG } from './config.js';
import { initPauseScreen } from './core/pauseScreen.js';

(function () {
  let instance = null;
  let bootDebounce = null;

  // Re-entry guard. createOverlay() has no #pause-overlay check, so a double injection would stack
  // two overlays and two MutationObservers on the same page — and the diagnostics below would
  // cheerfully report the second copy as healthy.
  if (window.JFPauseScreen) {
    console.warn(`[PauseScreen] v${CONFIG.version} not started — v${window.JFPauseScreen.version} is already running (double injection).`);
    return;
  }

  // Diagnostics. Without a marker, "the script never arrived" and "the script arrived but never
  // booted" are indistinguishable on a TV or a phone — which is exactly the failure that is
  // expensive to diagnose remotely. Defined immediately, so its mere presence proves delivery.
  window.JFPauseScreen = {
    version: CONFIG.version,
    status() {
      const video = typeof instance?.getVideo === 'function' ? instance.getVideo() : null;
      return {
        version: CONFIG.version,
        booted: !!instance,
        boundToVideo: !!video,
        paused: video ? video.paused : null,
        overlayInDom: !!document.getElementById('pause-overlay'),
        stylesInDom: !!document.getElementById('pause-overlay-style'),
        playerContainer: !!document.querySelector('.videoPlayerContainer'),
        videoElement: !!document.querySelector('.videoPlayerContainer video')
      };
    }
  };
  console.info(`[PauseScreen] v${CONFIG.version} loaded — run window.JFPauseScreen.status() to diagnose`);

  const bootObserver = new MutationObserver((mutations) => {
    const hasNodeChanges = mutations.some(m => m.addedNodes.length > 0 || m.removedNodes.length > 0);
    if (!hasNodeChanges) return;

    clearTimeout(bootDebounce);
    bootDebounce = setTimeout(() => {
      const videoEl = document.querySelector('.videoPlayerContainer video');
      if (videoEl) {
        if (!instance) {
          instance = initPauseScreen(bootObserver);
        }
        if (instance.getVideo() !== videoEl) {
          instance.bindVideo(videoEl);
        }
      } else if (instance && !videoEl) {
        instance.destroy();
        instance = null;
      }
    }, 100);
  });

  bootObserver.observe(document.documentElement, { childList: true, subtree: true });

  const initialVideo = document.querySelector('.videoPlayerContainer video');
  if (initialVideo) {
    instance = initPauseScreen(bootObserver);
    instance.bindVideo(initialVideo);
  }
})();
