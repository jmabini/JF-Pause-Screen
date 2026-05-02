import { initPauseScreen } from './core/pauseScreen.js';

(function () {
  let instance = null;
  let bootDebounce = null;

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
