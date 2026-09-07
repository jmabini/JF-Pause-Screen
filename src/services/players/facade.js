/**
 * UNIVERSAL PLAYER FAÇADE — a duck-typed HTMLMediaElement over a Jellyfin player object
 *
 * WHAT THIS WRAPS: the live player object captured by Route C (see detect.js), i.e.
 * Jellyfin's own `htmlVideoPlayer` / `mpvVideoPlayer` plugin instance. It does NOT wrap
 * `window.api` — the mpv `window.api` façade in MASTER_PLAN_CLIENT_COMPAT.md §5 is
 * SUPERSEDED by MASTER_PLAN_V2_UNIVERSAL.md §1. The design decision from §5 still holds
 * though: present an HTMLMediaElement-like surface so `pauseScreen.js` changes as little
 * as possible (it changes by two lines: an import and the boot-time detect call).
 *
 * THE SURFACE — the nine members `pauseScreen.js` + `image.js` empirically use
 * (MASTER_PLAN_CLIENT_COMPAT.md §5):
 *   paused (get) · currentTime (get/set) · duration (get) · play() (must be a thenable)
 *   · pause() · readyState · addEventListener/removeEventListener · getAttribute('poster')
 * Confirmed unused and therefore deliberately absent: buffered, playbackRate, currentSrc,
 * videoWidth/videoHeight (the ResizeObserver watches document.body, not the video).
 *
 * Plus one addition of our own: `psItemId`, the Route C item-id override consumed by
 * image.js `getItemId()`. A raw <video> element does not have it, so the browser path
 * falls straight through to the unchanged DOM derivation.
 *
 * FAIL CLOSED: every call into the player goes through readRaw()/safeCall(). Three
 * throws and guard.js disables the whole feature; the native player is untouched.
 */
import { noteFailure, safeCall } from './guard.js';

/** Events the façade can emit. bindVideo() in pauseScreen.js registers all seven. */
const SUPPORTED_EVENTS = [
  'loadstart',
  'emptied',
  'ended',
  'pause',
  'play',
  'seeked',
  'loadedmetadata'
];

/**
 * Build a façade over `player`.
 *
 * @param {object} player       the captured Jellyfin player object
 * @param {function} readItemId returns the current NowPlayingItem.Id, or null
 * @returns {object|null} the façade, or null if the environment cannot support it
 */
export function createPlayerFacade(player, readItemId) {
  const Events = typeof window !== 'undefined' ? window.Events : null;

  // Fail closed. Without Events.on there is no way to learn about pause/unpause, and a
  // façade that silently never fires is worse than no façade at all.
  if (!player || !Events || typeof Events.on !== 'function') return null;
  if (typeof player.currentTime !== 'function' || typeof player.duration !== 'function') return null;

  // ── THE SINGLE UNIT CHOKEPOINT (B1, G-4) ─────────────────────────────────────────
  // B1: player.currentTime() and player.duration() are MILLISECONDS, uniformly across
  // htmlVideoPlayer (jellyfin-web htmlvideoplayer/plugin.js:1791-1818) and mpvVideoPlayer
  // (jellyfin-desktop native/mpvVideoPlayer.js:642-649). Every other file in this repo
  // works in SECONDS. Do NOT reach for playbackManager.getCurrentTicks(): that returns
  // TICKS (playbackmanager.js:2256 = Math.floor(10000 * player.currentTime())), which is
  // a 10,000,000x error against seconds and would corrupt the progress bar width, the
  // "% watched" figure and the "Ends at" clock. If ticks are ever unavoidable the
  // conversion is seconds = ticks / 10_000_000.
  //
  // G-4: these two arrow functions are the ONLY place in the codebase allowed to
  // multiply or divide by 1000 anywhere near currentTime/duration. Reviewers grep for
  // stray *1000 / /1000 outside this block.
  const msToSec = (ms) => (Number.isFinite(ms) ? ms / 1000 : NaN);
  const secToMs = (sec) => (Number.isFinite(sec) ? sec * 1000 : NaN);
  // ─────────────────────────────────────────────────────────────────────────────────

  // Mirrors. Every one of these exists because of B4 (see readers below): they are the
  // last-known-good value returned when the player hands back undefined/null/NaN.
  let pausedMirror = false;
  let timeSec = 0;
  let durationSec = 0;
  let destroyed = false;

  /**
   * R1 — `loadedmetadata` is announced ONCE PER ITEM, at the start of the item, and never
   * again. It is NOT tied to duration becoming known.
   *
   * This is the contract a real HTMLMediaElement keeps and the façade must too. The
   * consumer, `handleLoadedMetadata` in pauseScreen.js, opens with `purge()` — so an
   * element that can emit `loadedmetadata` at an arbitrary point in an item's life is an
   * element that can destroy a visible overlay at an arbitrary point. mpv publishes its
   * duration up to ~500 ms after playback starts, so "dispatch when duration arrives"
   * routinely landed AFTER the user had already paused: the overlay came up, then the
   * next timeupdate purged it, and no further `pause` was coming to bring it back.
   * Deferring the dispatch by a microtask (the first attempt at this) did not help — it
   * merely reordered `pause -> showOverlay` ahead of `loadedmetadata -> purge`, which is
   * strictly worse.
   *
   * Duration arriving late is now a silent state update plus, if the overlay may be up, a
   * synthesized `seeked` — see refreshDuration().
   */
  let hasAnnouncedMetadata = false;
  let hasKnownDuration = false;

  // B7 seek-settle bookkeeping. See readPositionSec().
  let pendingSeekSec = null;
  let pendingSeekAt = 0;
  const SEEK_SETTLE_MS = 900; // comfortably longer than mpv's ~500 ms positionUpdate gap

  const listeners = new Map();
  SUPPORTED_EVENTS.forEach(type => listeners.set(type, new Set()));

  /** Read a player accessor without ever letting it throw into our caller. */
  function readRaw(fn, where) {
    try {
      return fn();
    } catch (err) {
      noteFailure(where, err);
      return undefined;
    }
  }

  /**
   * F4: deliberately NOT routed through safeCall(). safeCall refuses to run once the
   * error budget is gone, and every outbound event goes through here — so swallowing
   * them meant: overlay visible, 3 throws, user resumes, the player's 'unpause' can no
   * longer reach hideOverlay(), and an opaque z-index:2147483647 layer is left over
   * playing video with no escape. Listener throws are still CHARGED to the budget (which
   * now tears the feature down properly), but the event is always delivered, and one
   * listener throwing never stops the next one from running.
   */
  function dispatch(type) {
    if (destroyed) return;
    const set = listeners.get(type);
    if (!set || set.size === 0) return;
    // Copy first: pauseScreen.js's handlers can call removeEventListener (unbindVideo)
    // from inside a dispatch, which would otherwise mutate the Set mid-iteration.
    for (const fn of [...set]) {
      try {
        fn({ type, target: facade });
      } catch (err) {
        noteFailure(`facade-listener-${type}`, err);
      }
    }
  }

  /** Dispatch out of the current stack. See refreshDuration() for why this matters (F7). */
  function dispatchAsync(type) {
    Promise.resolve().then(() => dispatch(type));
  }

  /**
   * B4: mpv's currentTime() is `undefined` before the first positionUpdate tick and
   * `null` after stop (mpvVideoPlayer.js:83, :144, :247, :455). Feeding either into
   * arithmetic yields NaN, which then lands verbatim in the clock text and — far worse —
   * in a CSS width (`width: NaN%`), which silently voids the declaration. Guard EVERY
   * read with Number.isFinite() and fall back to the mirror.
   */
  function readPositionSec() {
    const sec = msToSec(readRaw(() => player.currentTime(), 'facade-currentTime'));
    if (Number.isFinite(sec) && sec >= 0) {
      // B7: mpv caches its position at roughly 2 Hz, so for up to ~500 ms after a seek
      // the player still reports the PRE-seek position. Taking it at face value would
      // snap the progress bar backwards and then forwards again on the next tick. Hold
      // the optimistic value until the player agrees — or until the settle window
      // expires, so a seek the player silently rejected still recovers on its own.
      if (pendingSeekSec !== null) {
        if (Math.abs(sec - pendingSeekSec) < 1) {
          pendingSeekSec = null;
        } else if (Date.now() - pendingSeekAt < SEEK_SETTLE_MS) {
          return timeSec;
        } else {
          pendingSeekSec = null;
        }
      }
      timeSec = sec;
      return sec;
    }
    return timeSec;
  }

  /**
   * Announce the start of an item: `loadstart` -> `loadedmetadata`, in that order and once
   * only (R1). Asynchronous so it can never land in the middle of a consumer render — a
   * microtask queue preserves the order between the two.
   *
   * `loadedmetadata` is emitted whether or not the duration is known yet. That is the
   * honest translation of Jellyfin's model into the HTMLMediaElement one: `playbackstart`
   * means the item is real and identified (`state.NowPlayingItem.Id` is already in hand,
   * which is all `handleLoadedMetadata`'s prefetch actually needs), even though mpv will
   * not publish a duration for another ~500 ms. updateProgress() degrades gracefully in
   * the meantime — `Number.isFinite(duration) && duration > 0` is false, so it prints
   * "Duration unavailable" rather than a NaN bar — and refreshDuration() below repairs the
   * readout the moment the real value lands.
   */
  function announceItemStart() {
    hasAnnouncedMetadata = true;
    hasKnownDuration = false;
    dispatchAsync('loadstart');
    dispatchAsync('loadedmetadata');
  }

  /**
   * B4 for duration. A zero/absent duration is legitimate (Live TV, mpv before the first
   * updateDuration). This function NEVER dispatches `loadedmetadata` — see R1 above.
   */
  function refreshDuration() {
    const sec = msToSec(readRaw(() => player.duration(), 'facade-duration'));
    if (Number.isFinite(sec) && sec > 0) {
      const firstTime = !hasKnownDuration;
      durationSec = sec;
      hasKnownDuration = true;
      // R1: the duration arriving late is the ONLY thing that happens here, plus a nudge
      // to redraw. `seeked` is the one event pauseScreen.js maps to a bare
      // updateProgress() (onSeeked, guarded by isOverlayVisible && paused), so it is the
      // correct — and only non-destructive — way to refresh a progress bar that is
      // currently reading "Duration unavailable". Async, for the same reason as every
      // other dispatch: never re-enter a consumer that is mid-render.
      if (firstTime && hasAnnouncedMetadata && pausedMirror) dispatchAsync('seeked');
      return true;
    }
    return false;
  }

  /**
   * The player's OWN answer, or undefined when it will not give one. Kept separate from
   * readPaused() because "the player says it is paused" and "we have no idea, here is our
   * last guess" are different facts, and R4 turned on conflating them.
   */
  function rawPaused() {
    const raw = readRaw(() => (typeof player.paused === 'function' ? player.paused() : undefined), 'facade-paused');
    return typeof raw === 'boolean' ? raw : undefined;
  }

  function readPaused() {
    const raw = rawPaused();
    if (raw !== undefined) {
      pausedMirror = raw;
      return raw;
    }
    // B4-shaped hazard on the boolean too: mpv reports paused state through events long
    // before paused() is meaningful. Fall back to the event-driven mirror.
    return pausedMirror;
  }

  // ── Player event handlers ────────────────────────────────────────────────────────

  // Dedupe state for play/pause dispatches. Deliberately SEPARATE from pausedMirror:
  // pausedMirror is overwritten by whatever player.paused() reports, and after a stop
  // Jellyfin's players report `false`. Deduping on pausedMirror therefore swallowed the
  // next item's 'unpause' — 'play' never reached pauseScreen.js, hasStartedPlaying stayed
  // false, and the overlay never appeared again for the rest of the session. Only our own
  // dispatches move this value, and a stop/new-item clears it.
  let lastDispatchedPlayState = null; // 'play' | 'pause' | null

  function onPlayerPause() {
    if (lastDispatchedPlayState === 'pause') return; // 'pause' can arrive more than once
    lastDispatchedPlayState = 'pause';
    pausedMirror = true;
    readPositionSec();
    refreshDuration();
    dispatch('pause');
  }

  function onPlayerUnpause() {
    if (lastDispatchedPlayState === 'play') return; // 'unpause' and 'playing' both land here
    lastDispatchedPlayState = 'play';
    pausedMirror = false;
    dispatch('play');
  }

  /**
   * F8: 'playing' is NOT a synonym for 'unpause'. Jellyfin emits it after a buffering
   * stall and, on some backends, after a seek performed while paused. Treating it as a
   * resume hid the overlay while playback was still paused — and no 'pause' follows to
   * bring it back, so the user is left staring at a frozen frame.
   *
   * R4: the veto must come from the PLAYER (rawPaused), never from readPaused(). On mpv —
   * the very player B4 exists for — paused() returns a non-boolean, so readPaused() falls
   * back to pausedMirror, which onPlayerPause() has just set to true. A resume signalled
   * only by 'playing' was therefore discarded outright and the overlay never came down.
   * Only a definite "yes, still paused" from the player blocks the resume; "don't know"
   * defers to the event, which is the only information we actually have.
   */
  function onPlayerPlaying() {
    if (rawPaused() === true) return;
    onPlayerUnpause();
  }

  function onPlayerTimeUpdate() {
    const previous = timeSec;
    const next = readPositionSec();
    if (!hasKnownDuration) refreshDuration();

    // B7: mpv caches its position at roughly 2 Hz, so a seek issued while paused only
    // shows up on the next positionUpdate — up to ~500 ms later. That is accepted, not
    // worked around: busy-polling the player for a faster settle would burn CPU behind a
    // static overlay for a cosmetic gain nobody can perceive. The optimistic local write
    // in the currentTime setter already makes the UI feel immediate.
    if (pausedMirror && Math.abs(next - previous) > 0.25) dispatch('seeked');
  }

  function onPlayerStopped() {
    // No 'ended' is synthesized on purpose. pauseScreen.js maps 'ended' to
    // onEnded() = purge() + onPlay(), and 'emptied' to a purge that also clears
    // hasStartedPlaying (B5). Jellyfin's 'stopped' covers both "finished" and "user
    // stopped", so the stricter of the two is the correct mapping.
    hasAnnouncedMetadata = false;
    hasKnownDuration = false;
    durationSec = 0;
    timeSec = 0;
    pendingSeekSec = null;
    pausedMirror = true;            // matches a real HTMLMediaElement after `emptied`
    lastDispatchedPlayState = null; // re-arm: the next item's 'unpause' MUST get through
    dispatch('emptied');
  }

  // Route C hands us the same player object for consecutive items, so subscribe once.
  // (`Events.on` is Jellyfin's own emitter; its handler signature is
  // `(eventObject, ...triggerArgs)` — we need none of the arguments.)
  safeCall(() => {
    Events.on(player, 'pause', onPlayerPause);
    Events.on(player, 'unpause', onPlayerUnpause);
    Events.on(player, 'playing', onPlayerPlaying); // F8: verified against real paused state
    Events.on(player, 'timeupdate', onPlayerTimeUpdate);
    Events.on(player, 'stopped', onPlayerStopped);
  }, 'facade-subscribe', undefined);

  const facade = {
    /** Marker so status()/tests can tell a façade from a real <video> without a name check. */
    __isPauseScreenFacade: true,

    get paused() {
      return readPaused();
    },

    get currentTime() {
      return readPositionSec();
    },

    /**
     * B3: do NOT route this through playbackManager.seek(). seek() goes via changeStream
     * (playbackmanager.js:1647-1656) and can RESUME playback, which would dismiss the
     * overlay on every arrow-key seek — the exact interaction the feature exists for.
     * seekRelative() is worse still: an upstream temporal-dead-zone bug at :1658-1666.
     * Write straight to the player instead.
     */
    set currentTime(sec) {
      const ms = secToMs(sec);
      if (!Number.isFinite(ms) || ms < 0) return; // B4: never hand the player a NaN
      // Optimistic local write. pauseScreen.js:1117 is read-modify-write, so without
      // this a fast double arrow-press would read a stale position and clobber itself.
      timeSec = msToSec(ms); // back through the chokepoint, never a loose /1000
      pendingSeekSec = timeSec;
      pendingSeekAt = Date.now();
      safeCall(() => player.currentTime(ms), 'facade-seek', undefined);
      // No player emits 'seeked'; synthesize it. Async so the overlay's onSeeked ->
      // updateProgress() cannot re-enter this setter within the same tick.
      Promise.resolve().then(() => dispatch('seeked'));
    },

    get duration() {
      refreshDuration();
      return durationSec;
    },

    /**
     * Used once, in bindVideo(): `if (el.readyState >= 1) handleLoadedMetadata()`.
     *
     * R1: keyed to the ITEM being announced, not to the duration being known. A façade is
     * only ever handed to bindVideo() after Route C captured a live `playbackstart`, so at
     * bind time the item is real and identified and the prefetch should run — waiting for
     * mpv's duration would have delayed it by up to ~500 ms for no benefit, since the
     * prefetch keys off the item id, not the duration.
     */
    get readyState() {
      return hasAnnouncedMetadata ? 4 : 0;
    },

    /**
     * Route C item-id override, consumed by image.js getItemId(). MASTER_PLAN_V2 §1:
     * `state.NowPlayingItem.Id` arrives in the very payload the capture layer reads,
     * Live TV included — which matters because mpv populates neither the <video> poster
     * attribute nor the OSD `data-id` buttons that getItemId() otherwise scrapes.
     */
    get psItemId() {
      return safeCall(() => (typeof readItemId === 'function' ? readItemId() : null), 'facade-itemid', null);
    },

    /**
     * B2: playbackManager.unpause() returns undefined (playbackmanager.js:3991-3995),
     * and all three of our resume call sites do `video.play().catch(...)`
     * (pauseScreen.js:1076, :1243, :1264). Returning the raw result would throw a
     * TypeError on EVERY resume — and only on user interaction, so it would never show
     * up in a smoke test that does not click. Always return a real Promise.
     *
     * Note the deliberate absence of a `player.play()` fallback: on Jellyfin players
     * `play(options)` starts a NEW item rather than resuming the current one, so calling
     * it here would restart playback from the beginning. If unpause() is missing we fail
     * closed instead.
     */
    play() {
      if (typeof player.unpause !== 'function') {
        return Promise.reject(new Error('[PauseScreen] captured player has no unpause()'));
      }
      try {
        const result = player.unpause();
        // Optimistic only. Deliberately does NOT touch lastDispatchedPlayState: if the
        // player emits its 'unpause' asynchronously, pre-setting the dedupe here would
        // swallow the 'play' that pauseScreen.js is waiting for.
        pausedMirror = false;
        return Promise.resolve(result);
      } catch (err) {
        noteFailure('facade-play', err);
        return Promise.reject(err);
      }
    },

    pause() {
      if (typeof player.pause !== 'function') return;
      safeCall(() => player.pause(), 'facade-pause', undefined);
      pausedMirror = true;
    },

    /**
     * image.js reads `getAttribute('poster')`. mpv has no poster and no DOM node, so the
     * honest answer is null; getItemId() then falls through to its URL/OSD derivation,
     * which the psItemId override above has already short-circuited anyway.
     */
    getAttribute() {
      return null;
    },

    addEventListener(type, handler) {
      const set = listeners.get(type);
      if (set && typeof handler === 'function') set.add(handler);
    },

    removeEventListener(type, handler) {
      const set = listeners.get(type);
      if (set) set.delete(handler);
    },

    /**
     * Called by detect.js when Route C sees a `playbackstart` for a NEW item on the SAME
     * player object. pauseScreen.js's bindVideo() early-returns in that case (the façade
     * identity has not changed), so without this the overlay would keep showing the
     * previous episode's metadata. The event order mirrors a real <video> switching src:
     * loadstart (purge) -> loadedmetadata (prefetch) -> play.
     *
     * F8: the play state is READ, not assumed. Hard-coding 'play' here deduped away the
     * real 'pause' of an item that starts paused (a resume prompt), so the overlay never
     * appeared for it. When the item does start paused we leave the dedupe unset so the
     * player's own 'pause' gets through on its merits.
     *
     * R4: read it with rawPaused(), not readPaused(). On mpv, paused() returns a
     * non-boolean, so readPaused() would hand back the stale mirror; a new item that
     * started while the mirror said "paused" then never dispatched `play`, leaving
     * pausedMirror stuck true for the whole item — and `facade.paused` lying to
     * onGlobalScreenTap and onSeeked. `playbackstart` means playback started, so
     * "don't know" resolves to playing.
     *
     * ACCEPTED COST, recorded so the next reader knows it was considered: every item
     * change tears the overlay down and clears the blob/image caches via purge(), so the
     * façade path re-fetches backdrops and re-runs the blur worker per episode where the
     * browser path (which rebinds the same <video>) does not. Correctness is identical;
     * this is bandwidth and a little CPU, on desktop, once per episode.
     */
    __onPlaybackStart() {
      durationSec = 0;
      timeSec = 0;
      pendingSeekSec = null;
      const playing = rawPaused() !== true;
      pausedMirror = !playing;
      lastDispatchedPlayState = playing ? 'play' : null;
      // loadstart -> loadedmetadata, both async and in order (R1).
      announceItemStart();
      refreshDuration();
      if (playing) dispatchAsync('play');
    },

    /**
     * Not called by pauseScreen.js (unbindVideo() only removes our listeners), but kept
     * so the façade can be torn down explicitly. The Events.on subscriptions above are
     * intentionally left in place: Jellyfin players are singletons and detect.js memoizes
     * one façade per player object in a WeakMap, so the subscription count is bounded by
     * the number of player plugins, not by the number of items played.
     */
    __destroy() {
      destroyed = true;
      listeners.forEach(set => set.clear());
    }
  };

  // Prime the mirrors so the very first read is already correct where possible.
  //
  // R1: the item is announced as already started. createPlayerFacade() is only reached
  // from detectPlayerTarget() after Route C captured a live `playbackstart`, so the item
  // IS real and identified — readyState must therefore report >= 1 straight away, which is
  // what makes bindVideo() run handleLoadedMetadata() (purge + prefetch) on the first
  // bind. No events are dispatched here: nothing is listening yet, since bindVideo() has
  // not been called.
  hasAnnouncedMetadata = true;
  readPaused();
  readPositionSec();
  refreshDuration();

  return facade;
}
