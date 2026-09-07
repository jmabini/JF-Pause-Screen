/**
 * PLAYER DETECTION + ROUTE C CAPTURE LAYER
 *
 * Route C (MASTER_PLAN_V2_UNIVERSAL.md §1): jellyfin-web's `src/index.jsx:58` assigns
 * `window.Events = Events` — a plain object literal from `src/utils/events.ts:25-49`
 * whose `trigger` is writable, not frozen — and it is the same singleton every player and
 * `playbackManager` uses. Every playback state change flows through it:
 *
 *     Events.trigger(self, 'playbackstart', [player, state]);   // self === playbackManager
 *
 * So we wrap `Events.trigger`, capture the `playbackManager` singleton AND the live
 * player object, then unwrap ourselves and use the ordinary
 * `Events.on(player, 'pause' | 'unpause' | 'timeupdate')` API from there on. This is
 * player-agnostic: it reads Jellyfin's own playback state rather than an HTML5 <video>.
 *
 * THREE RULES THIS FILE EXISTS TO ENFORCE:
 *
 *  1. `detectPlayerTarget()` returns the RAW <video> element whenever one exists. The
 *     browser path must be handed the exact same object it is handed today — not a
 *     wrapper, not a proxy (G-1).
 *
 *  2. A façade is only ever built where it can actually be SEEN — see
 *     facadePlatformSupported(). G-7 in spirit and in letter.
 *
 *  3. Fail closed. Every branch returns `null` rather than guessing. A null means the
 *     overlay does not appear and the native player keeps working.
 *
 * SCRIPT ORDERING (F1) — the single most important operational fact here. This project's
 * bundle is injected as an `async` <script> from a CDN with a multi-day browser cache,
 * while jellyfin-web's own bundle is `defer`. On a warm cache we therefore execute BEFORE
 * `index.jsx:58` has run, and `window.Events` does not exist yet. §1 of the plan presents
 * "a classic injected <script> runs first" as an advantage; it is in fact this hazard, and
 * MASTER_PLAN_CLIENT_COMPAT §5 had the equivalent right for `window.api` ("assigned
 * asynchronously -> use window.apiPromise, and add a one-shot boot kick"). Arming
 * therefore RETRIES — bounded — instead of bailing once.
 */
import { isUniversalPlayerEnabled, androidVetoMode, safeCall, noteFailure, logFailureOnce, guardStatus } from './guard.js';
import { createPlayerFacade } from './facade.js';

/** The one boot gate this project has ever used. Unchanged on purpose. */
const VIDEO_SELECTOR = '.videoPlayerContainer video';

/**
 * Idempotency marker for the Events.trigger wrap (§4, "Events.trigger wrap discipline").
 * A property rather than a WeakSet so a second copy of this script — or a rebuilt copy
 * after a hot reload — can see the mark on a function it did not create.
 */
const TRIGGER_MARK = '__jfPauseScreenTriggerWrap';

/** F1 retry bounds. Generous enough for a cold jellyfin-web boot, finite enough to stop. */
const ARM_MAX_ATTEMPTS = 400;
const ARM_DEADLINE_MS = 90000;

let armed = false;              // inert until armed; cleared once the capture is complete
let ourWrapper = null;          // the exact function object we installed
let originalTrigger = null;     // the function we displaced
let wrapperOrphaned = false;    // our wrapper is still in the chain but no longer outermost
let deactivateWrapper = null;   // kills the CURRENT wrapper's own closure-local liveness
let captured = null;            // { playbackManager, player, itemId }
let subscribedManager = null;   // playbackManager we have already attached Events.on to
let armAttempts = 0;
let armStartedAt = 0;
let armGaveUp = false;

const facadeByPlayer = new WeakMap();
const captureListeners = new Set();
const playbackErrorListeners = new Set();

/**
 * B6 discipline, generalised: feature-detect the object SHAPE, never trust a name.
 * A Jellyfin player exposes currentTime()/duration() as METHODS (an HTMLMediaElement
 * exposes them as properties), which is what distinguishes it from every other object
 * that might travel through Events.trigger.
 */
function looksLikePlayer(candidate) {
  return !!candidate
    && typeof candidate === 'object'
    && typeof candidate.currentTime === 'function'
    && typeof candidate.duration === 'function'
    && typeof candidate.pause === 'function';
}

/**
 * Shape test for the playbackManager singleton. Capturing it is what keeps
 * `playbackstart` (item changes), `playbackstop` and `playbackerror` flowing after the
 * trigger wrap is removed — so the wrap is NOT removed until we have it (F3).
 */
function looksLikePlaybackManager(candidate) {
  return !!candidate
    && typeof candidate === 'object'
    && typeof candidate.currentItem === 'function'
    && typeof candidate.getPlayerInfo === 'function'
    && typeof candidate.isPlayingVideo === 'function';
}

/**
 * F6 — THE PLATFORM GATE. A façade is only correct where the web layer composites ABOVE
 * the video. That is jellyfin-desktop's Qt WebEngine view over mpv: `setTransparency(2)`
 * resolves to `dashboard.setBackdropTransparency`, which is how the native OSD is visible
 * at all (MASTER_PLAN_V2 §6). jellyfin-desktop is the only client that defines
 * `window.jmpInfo` — the exact signal MASTER_PLAN_CLIENT_COMPAT §6 G-7 names.
 *
 * Android is what this exists to exclude, and nothing else was enforcing it. With
 * `enableUniversalPlayer: true` + `androidForceWebPlayer: 'auto'` — the plan's own
 * recommended pairing — an MKV/HEVC item is correctly NOT vetoed, ExoPlayer plays it
 * natively above the WebView (`ActivityEventHandler.kt:62-67` stacks PlayerFragment over
 * it), the ExoPlayer plugin instance satisfies looksLikePlayer(), and no <video> exists.
 * A façade would then boot and paint an opaque full-screen overlay nobody can see —
 * until the user exits the native player and lands on it, over the library. Android is
 * served by the veto, which puts a real <video> back on screen. Never by the façade.
 */
function facadePlatformSupported() {
  return typeof window !== 'undefined' && !!window.jmpInfo;
}

/**
 * §1: `state.NowPlayingItem` (playbackmanager.js:661-675) carries `Id` in the very
 * payload we capture — Live TV included. Returned unvalidated on purpose: image.js
 * owns the id format check (isValidItemId) and duplicating it here would let the two
 * drift apart.
 */
function readItemIdFromState(state) {
  return (state && state.NowPlayingItem && state.NowPlayingItem.Id) || null;
}

function notifyCapture() {
  for (const fn of [...captureListeners]) {
    safeCall(() => fn(), 'capture-listener', undefined);
  }
}

function notifyPlaybackError() {
  for (const fn of [...playbackErrorListeners]) {
    safeCall(() => fn(), 'playbackerror-listener', undefined);
  }
}

/** Shared by the trigger hook and the manager subscription so the two cannot diverge. */
function applyPlaybackStart(playbackManager, player, state) {
  captured = {
    playbackManager: playbackManager || (captured && captured.playbackManager) || null,
    player,
    itemId: readItemIdFromState(state)
  };

  // R2 — the trigger is "a façade for this player already exists", NOT "captured.player
  // still matched". The previous `isSamePlayer` test looked correct and failed on the
  // single most common transition there is: episode -> next episode emits playbackstop
  // (which clearCapture() nulls `captured` on) before playbackstart, so isSamePlayer was
  // false, __onPlaybackStart() never ran, and nothing else picked up the slack —
  // bindVideo() no-ops on unchanged identity, so there was no loadstart, no purge and no
  // prefetch. The overlay kept showing the PREVIOUS episode's title, logo, synopsis,
  // chapter ticks and backdrop. If a façade exists, the item change has to be announced
  // to it, full stop.
  const facade = facadeByPlayer.get(player);
  if (facade) safeCall(() => facade.__onPlaybackStart(), 'facade-item-change', undefined);

  notifyCapture();
}

/**
 * F5 — playback stopped. `captured` MUST be cleared here. Without it
 * detectPlayerTarget() keeps returning the memoized façade for the life of the page,
 * main.js's destroy branch is unreachable, and the pause screen's document-level
 * `keydown` handler stays bound forever — which makes Escape ANYWHERE in Jellyfin click
 * `.headerBackButton`. That is real navigation hijacking, and it collides with other
 * userscripts (KefinTweaks, Intro Skipper). The touchstart/touchend handlers and the
 * ResizeObserver leak the same way.
 */
function clearCapture() {
  if (!captured) return;
  captured = null;
  notifyCapture();
}

/**
 * After the capture we no longer touch Events.trigger; item changes, stops and errors
 * arrive through the ordinary Events.on API on the playbackManager singleton.
 * Returns true if the subscription is (or already was) in place.
 */
function subscribeToManager(playbackManager) {
  if (!playbackManager) return false;
  if (subscribedManager === playbackManager) return true;
  const Events = window.Events;
  if (!Events || typeof Events.on !== 'function') return false;
  const attached = safeCall(() => {
    // Handler signature is (eventObject, ...triggerArgs) — see events.ts triggerSingle.
    Events.on(playbackManager, 'playbackstart', (e, player, state) => {
      if (!looksLikePlayer(player)) return;
      applyPlaybackStart(playbackManager, player, state);
    });
    Events.on(playbackManager, 'playbackerror', () => notifyPlaybackError());
    Events.on(playbackManager, 'playbackstop', () => clearCapture());
    return true;
  }, 'manager-subscribe', false);
  if (attached) subscribedManager = playbackManager;
  return attached;
}

/**
 * The capture hook. Runs in a `finally`, so it must never change what `trigger` returns
 * or throws — the caller wraps this in its own try/catch as a second line of defence.
 */
function captureHook(obj, type, args) {
  if (!armed) return; // inert until armed

  // Forwarded even before capture: on Android an item can fail to start before any
  // playbackstart is emitted, and the veto's auto-suspend must hear about it.
  if (type === 'playbackerror') {
    notifyPlaybackError();
    return;
  }
  if (type === 'playbackstop') {
    clearCapture();
    return;
  }
  if (type !== 'playbackstart') return;

  const list = Array.isArray(args) ? args : [];
  const player = list[0];
  if (!looksLikePlayer(player)) return; // shape, never name

  const playbackManager = looksLikePlaybackManager(obj) ? obj : null;
  applyPlaybackStart(playbackManager, player, list[1]);

  // F3 — stand down ONLY once the ongoing source of events is in hand. The first version
  // disarmed unconditionally here, while subscribeToManager() silently no-ops when the
  // manager shape does not match: that permanently lost `playbackerror` forwarding, which
  // is the ONLY safety valve preventing the Android veto from hard-breaking playback
  // (§3). If we did not get the manager, stay wrapped and try again next playbackstart.
  if (subscribeToManager(playbackManager)) {
    armed = false;
    disarmTrigger();
  }
}

/**
 * Restore Events.trigger — but ONLY if we are still the outermost wrapper. Other
 * Jellyfin userscripts stack wrappers on the same singleton; blindly assigning
 * `originalTrigger` back would silently delete whatever they installed on top of us.
 */
function disarmTrigger() {
  // R3: kill THIS wrapper's own liveness flag first, in every branch. `armed` is a
  // module-level global, so relying on it alone to keep a fossil inert was only true
  // until something set it back to true. A per-closure flag cannot be revived by anything.
  if (deactivateWrapper) deactivateWrapper();
  const Events = typeof window !== 'undefined' ? window.Events : null;
  if (!Events || !ourWrapper) return;
  if (Events.trigger === ourWrapper) {
    Events.trigger = originalTrigger;
    ourWrapper = null;
    originalTrigger = null;
    deactivateWrapper = null;
    return;
  }
  // Not outermost: a foreign userscript stacked itself on top of us after we armed.
  // Restoring `originalTrigger` here would silently delete their hook, so ours stays in
  // the chain — now genuinely inert, via the closure flag above. Recorded so
  // detectStatus() does not report a fossil as an active wrap.
  wrapperOrphaned = true;
}

/**
 * Install the Events.trigger wrap. Idempotent, cheap, and designed to be called on every
 * boot tick: see the SCRIPT ORDERING note at the top of this file (F1).
 *
 * @param {function} [onCapture] invoked whenever the captured context changes
 */
export function armPlayerCapture(onCapture) {
  if (typeof onCapture === 'function') captureListeners.add(onCapture);
  // R3 — `subscribedManager` belongs in this gate. Without it, clearCapture() on every
  // playbackstop made `captured` null again and the next boot tick re-wrapped
  // Events.trigger, even though the manager subscription already delivers everything the
  // wrap was there to catch. Two live sources then fired applyPlaybackStart() twice per
  // playbackstart. Worse, `armed` is module-global and shared by every wrapper closure
  // ever installed, so a re-arm also REVIVED an orphaned wrapper's captureHook (one a
  // foreign userscript had stacked on top of), putting two of our hooks in one chain.
  // Once the subscription exists the wrap is permanently unnecessary — never re-arm.
  if (armed || captured || armGaveUp || subscribedManager) return;

  // The capture layer is shared by two features with independent switches: the façade
  // (CONFIG.enableUniversalPlayer) and the Android veto, which needs `playbackerror` for
  // its auto-suspend. Arm if EITHER wants it; touch nothing if neither does.
  if (!isUniversalPlayerEnabled() && androidVetoMode() === 'never') return;

  const Events = typeof window !== 'undefined' ? window.Events : null;
  if (!Events || typeof Events.trigger !== 'function') {
    // Not "the client is too old" — almost always just "jellyfin-web has not booted yet".
    // Retry silently; spend the one console.info only when we genuinely give up, so a
    // later real failure still has a line to report on.
    if (armStartedAt === 0) armStartedAt = Date.now();
    armAttempts += 1;
    const elapsed = Date.now() - armStartedAt;
    if (armAttempts >= ARM_MAX_ATTEMPTS || elapsed >= ARM_DEADLINE_MS) {
      armGaveUp = true;
      logFailureOnce(
        `window.Events never appeared (${armAttempts} attempts over ${Math.round(elapsed / 1000)}s) — ` +
        'the script is loading into a page that is not jellyfin-web, or jellyfin-web is older than 10.11'
      );
    }
    return;
  }

  if (Events.trigger[TRIGGER_MARK] && Events.trigger !== ourWrapper) {
    // Someone else already installed this exact wrapper (a second copy of the script).
    // Stacking a second capture hook would double-fire every listener; stay out. This is
    // terminal, so it does get the console.info.
    armGaveUp = true;
    logFailureOnce('another copy of this script already wrapped Events.trigger');
    return;
  }

  const displaced = Events.trigger;
  // R3: liveness lives in THIS closure, not in the module-level `armed`. A wrapper that
  // has been stood down can never be brought back to life by a later re-arm.
  let wrapperLive = true;
  const wrapper = function (obj, type, args) {
    // §4 wrap discipline: try/finally, NOT try/catch. events.ts:9-11 lets a subscriber's
    // throw propagate, and callers upstream rely on that; a catch here would swallow it
    // and change Jellyfin's own semantics. `finally` preserves both the return value and
    // the throw, whatever our hook does.
    try {
      return displaced.apply(this, arguments);
    } finally {
      try {
        if (wrapperLive) captureHook(obj, type, args);
      } catch (err) {
        noteFailure('capture-hook', err);
      }
    }
  };
  wrapper[TRIGGER_MARK] = true;

  originalTrigger = displaced;
  ourWrapper = wrapper;
  wrapperOrphaned = false;
  deactivateWrapper = () => { wrapperLive = false; };
  Events.trigger = wrapper;
  armed = true;
}

/**
 * THE BOOT GATE.
 *
 * Returns the raw <video> element when one exists — the identical object main.js and
 * pauseScreen.js bind today — and otherwise, only with every kill switch satisfied, a
 * supported platform and a live player captured, a façade. Returns null in every other
 * case.
 */
export function detectPlayerTarget() {
  const videoEl = typeof document !== 'undefined' ? document.querySelector(VIDEO_SELECTOR) : null;
  if (videoEl) return videoEl; // browser / Android-veto / Android-webui: unchanged path

  if (!isUniversalPlayerEnabled()) return null;
  if (!facadePlatformSupported()) return null;          // F6
  // Re-validated every call, not just at capture time: F5 clears `captured` on
  // playbackstop, and a stale player object must never keep an instance alive.
  if (!captured || !looksLikePlayer(captured.player)) return null;

  const player = captured.player;
  let facade = facadeByPlayer.get(player);
  if (!facade) {
    facade = safeCall(
      () => createPlayerFacade(player, () => (captured ? captured.itemId : null)),
      'facade-create',
      null
    );
    if (!facade) {
      logFailureOnce('the captured player could not be wrapped');
      return null;
    }
    facadeByPlayer.set(player, facade);
  }
  return facade;
}

/** Subscribe to `playbackerror`. Used by the Android veto's auto-suspend (§3). */
export function onPlaybackError(fn) {
  if (typeof fn !== 'function') return () => {};
  playbackErrorListeners.add(fn);
  return () => playbackErrorListeners.delete(fn);
}

/**
 * F3 — is anything actually going to tell us about a failed playback?
 *
 * True while the trigger wrap is armed (it forwards `playbackerror` directly) or once the
 * playbackManager subscription exists. The Android veto refuses to install unless this is
 * true, because without it the veto's only escape hatch does not exist and a
 * mis-approved item fails forever with no recovery.
 */
export function isPlaybackErrorObserved() {
  return armed || subscribedManager !== null;
}

/** Diagnostics for window.JFPauseScreen.status(). Never throws. */
export function detectStatus() {
  return {
    videoElement: typeof document !== 'undefined' && !!document.querySelector(VIDEO_SELECTOR),
    platformSupported: facadePlatformSupported(),
    triggerArmed: armed,
    triggerWrapActive: !!ourWrapper && !wrapperOrphaned,
    triggerWrapOrphaned: wrapperOrphaned,
    armAttempts,
    armGaveUp,
    playbackErrorObserved: isPlaybackErrorObserved(),
    playerCaptured: !!(captured && captured.player),
    playbackManagerCaptured: !!subscribedManager,
    capturedItemId: captured ? captured.itemId : null,
    facadeActive: !!(captured && captured.player && facadeByPlayer.has(captured.player)),
    guard: guardStatus()
  };
}
