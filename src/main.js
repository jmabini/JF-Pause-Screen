import { CONFIG } from './config.js';
import { initPauseScreen } from './core/pauseScreen.js';
import { armPlayerCapture, detectPlayerTarget, detectStatus } from './services/players/detect.js';
import { scanAndVeto, vetoStatus } from './services/players/androidVeto.js';
import { onAutoDisable } from './services/players/guard.js';

(function () {
  let instance = null;
  let bootDebounce = null;
  // R2: its OWN timer. Sharing bootDebounce with the MutationObserver meant a capture
  // change landing inside the 100 ms window CANCELLED the pending DOM-driven tick — and
  // with it that tick's armPlayerCapture() and scanAndVeto(), not just its evaluateBoot().
  let captureDebounce = null;

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
  //
  // MASTER_PLAN_V2_UNIVERSAL.md §5 names this the status surface for bug reports, so the
  // universal-player state (kill switches, capture, veto) is reported here too. Every field
  // below is computed defensively — status() must work even when the feature has failed.
  //
  // MEASURED DEAD WEIGHT, accepted: in a default-off build terser folds the feature away
  // but cannot fold these reporters, because they are reachable from here. ~856 bytes of
  // the +1.7 KB over v4.1.1 is reporter fields that can only ever read false/0/null on
  // such a build — `inactiveReason` plus `configEnabled` already say everything a bug
  // report needs. Kept anyway at ~1.4% of the bundle, because the alternative is a
  // support surface that goes blank in precisely the configuration people report from.
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
        videoElement: !!document.querySelector('.videoPlayerContainer video'),
        // true only when the overlay is driven by a façade instead of a real <video>.
        boundToFacade: !!(video && video.__isPauseScreenFacade),
        universalPlayer: detectStatus(),
        androidVeto: vetoStatus()
      };
    }
  };
  console.info(`[PauseScreen] v${CONFIG.version} loaded — run window.JFPauseScreen.status() to diagnose`);

  // The single place that decides what to bind to. detectPlayerTarget() hands back the raw
  // <video> element whenever one exists, so with the flags off this is byte-for-byte the same
  // decision the MutationObserver made before Route C existed.
  function evaluateBoot() {
    const target = detectPlayerTarget();
    if (target) {
      if (!instance) {
        instance = initPauseScreen(bootObserver);
      }
      if (instance.getVideo() !== target) {
        instance.bindVideo(target);
      }
    } else if (instance) {
      instance.destroy();
      instance = null;
    }
  }

  // Route C boot kick. mpv builds an EMPTY .videoPlayerContainer, so the DOM can be entirely
  // quiet at the moment playback starts and the MutationObserver below would never fire. The
  // capture callback re-runs the boot decision directly.
  function onCaptureChanged() {
    clearTimeout(captureDebounce);
    captureDebounce = setTimeout(evaluateBoot, 100);
  }

  /**
   * F1 — arming has to RETRY, and this tick is the retry driver.
   *
   * Our bundle is injected as an `async` <script> from a CDN with a multi-day cache while
   * jellyfin-web's own bundle is `defer`, so on a warm cache we run BEFORE
   * `index.jsx:58` assigns `window.Events`. Arming once at module-eval therefore failed on
   * essentially every load after the first, and Route C never armed at all. A dedicated
   * timer is unnecessary: this MutationObserver already fires continuously throughout
   * jellyfin-web's own bootstrap, which is exactly the window we are waiting on.
   * armPlayerCapture() is idempotent, bounded by attempts and a deadline, and a no-op once
   * armed, captured or given up — and a no-op from the first call when both flags are off,
   * so a default install never touches window.Events.
   *
   * scanAndVeto() rides the same tick, for the same reason: Jellyfin registers its player
   * plugins asynchronously, long after this script runs.
   */
  function bootTick() {
    armPlayerCapture(onCaptureChanged);
    scanAndVeto();
    evaluateBoot();
  }

  const bootObserver = new MutationObserver((mutations) => {
    const hasNodeChanges = mutations.some(m => m.addedNodes.length > 0 || m.removedNodes.length > 0);
    if (!hasNodeChanges) return;

    clearTimeout(bootDebounce);
    bootDebounce = setTimeout(bootTick, 100);
  });

  bootObserver.observe(document.documentElement, { childList: true, subtree: true });

  // F4 — when the error budget trips, DISMANTLE. Freezing the façade mid-state left an
  // opaque z-index:2147483647 overlay sitting over playing video with no way to dismiss
  // it. destroy() removes the overlay and every listener; the next boot tick will rebind
  // to a real <video> if one exists, so a browser self-heals within 100 ms.
  onAutoDisable(() => {
    if (!instance) return;
    instance.destroy();
    instance = null;
  });

  bootTick();
})();
