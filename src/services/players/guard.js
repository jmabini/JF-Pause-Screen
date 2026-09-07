/**
 * UNIVERSAL PLAYER — KILL SWITCHES + ERROR BUDGET
 *
 * MASTER_PLAN_V2_UNIVERSAL.md §5 ("Fail closed, always"): a failed guard means DO
 * NOTHING. The native player keeps working and the overlay simply does not appear —
 * which is exactly today's behaviour on Desktop/Android. Nothing in this directory
 * may ever throw into Jellyfin's own call stack.
 *
 * Four kill-switch layers. Any one of them being set disables the feature:
 *   1. build config          — CONFIG.enableUniversalPlayer / CONFIG.androidForceWebPlayer
 *   2. window.__PS_DISABLE   — set from DevTools, no rebuild, no reload of the script
 *   3. localStorage          — survives a reload, so a field user can disable it for good
 *   4. error budget          — 3 caught throws and the whole feature tears itself down
 *
 * ON LAYER 1 AND DEAD-CODE ELIMINATION — read this before reordering the checks.
 * Layer 1 is a build-time constant, so terser constant-folds `killSwitchReason()` and
 * strips the entire façade out of `dist/` whenever `enableUniversalPlayer` is false.
 * That is CORRECT and intended: flipping layer 1 requires a rebuild either way, and
 * layers 2-4 can only ever *disable* — with layer 1 already false there is nothing left
 * for them to switch off. A default-off build therefore ships no façade bytes at all.
 * v4.2.0 briefly tested the runtime layers first to defeat the fold; that shipped ~8.6 KB
 * of provably unreachable code to every client, did not actually prevent the fold, and
 * made layers 2-4 hit `localStorage` on every 100 ms boot tick. Reverted. The invariant is
 * asserted mechanically instead — see the dist checks in `scripts/smoke.mjs`.
 *
 * Layer 1 is tested FIRST in both predicates below, deliberately: it is the cheapest
 * check, it is the only one that can be folded away, and it keeps `localStorage` out of
 * the hot path on a default install.
 *
 * Exactly ONE console.info is emitted for the whole session (§5), and it is spent only on
 * a real, final failure — never on a condition we are still retrying. Everything else is
 * reported through window.JFPauseScreen.status().
 */
import { CONFIG } from '../../config.js';

/** Caught throws tolerated before the feature disables itself. §5. */
const ERROR_BUDGET = 3;

/** Layer 3. Value '1' or 'true' disables; anything else (including a throw) does not. */
const KILL_SWITCH_STORAGE_KEY = 'jfPauseScreenDisableUniversal';

let thrownCount = 0;
let autoDisabled = false;
let autoDisableReason = null;
let loggedOnce = false;
let lastError = null;

/**
 * F4 teardown hooks. Auto-disable must DISMANTLE the feature, not freeze it: see
 * tripAutoDisable().
 */
const teardownListeners = new Set();

/**
 * Layer 3. Private-mode Safari and hardened WebViews throw on localStorage access,
 * so a throw here must read as "not disabled" rather than propagate.
 */
function storageKillSwitchSet() {
  try {
    const value = localStorage.getItem(KILL_SWITCH_STORAGE_KEY);
    return value === '1' || value === 'true';
  } catch {
    return false;
  }
}

/**
 * The single console.info allowed per session (§5). Callers must only spend it on a
 * terminal condition — a retryable one (e.g. window.Events not there *yet*) would burn
 * the budget and silence the real failure that follows.
 */
export function logFailureOnce(reason) {
  if (loggedOnce) return;
  loggedOnce = true;
  console.info(
    `[PauseScreen] universal player inactive — ${reason}. ` +
    'Native playback is unaffected; run window.JFPauseScreen.status() for details.'
  );
}

/**
 * Register a teardown callback, run once when the error budget trips. main.js uses it to
 * destroy the pause-screen instance.
 */
export function onAutoDisable(fn) {
  if (typeof fn !== 'function') return () => {};
  teardownListeners.add(fn);
  return () => teardownListeners.delete(fn);
}

/**
 * F4 — auto-disable must TEAR DOWN, never freeze.
 *
 * The first version simply made safeCall() a no-op once the budget was gone. But every
 * façade -> pauseScreen event goes through that path, so the sequence was: overlay
 * visible -> 3 throws -> user resumes -> the player's 'unpause' can no longer be
 * dispatched -> hideOverlay() never runs. An opaque z-index:2147483647 layer then sits
 * over playing video with no mouse or keyboard escape. Dismantling is the only safe
 * response: destroy the instance, remove the overlay, leave the native player alone.
 */
function tripAutoDisable(reason) {
  if (autoDisabled) return;
  autoDisabled = true;
  autoDisableReason = reason;
  logFailureOnce(reason);
  const listeners = [...teardownListeners];
  teardownListeners.clear();
  // Out of the current stack: whatever just threw is still unwinding, and teardown
  // removes the very DOM/listeners that throw may have come from.
  setTimeout(() => {
    for (const fn of listeners) {
      try { fn(reason); } catch { /* teardown is best-effort by definition */ }
    }
  }, 0);
}

/**
 * Layer 4. Records a caught throw and trips the budget. Never rethrows: callers are
 * always inside a try/catch that has already decided to fail closed.
 */
export function noteFailure(where, err) {
  thrownCount += 1;
  lastError = `${where}: ${(err && err.message) || String(err)}`;
  if (thrownCount >= ERROR_BUDGET) {
    tripAutoDisable(`error budget exhausted (${thrownCount} throws, last ${lastError})`);
  }
}

/**
 * Run `fn`, swallow anything it throws, charge it to the error budget and return
 * `fallback`. This is the only way code in this directory should call INTO Jellyfin.
 *
 * It deliberately stops calling once auto-disabled — poking a player we have already
 * failed against three times is exactly what we do not want. Note that façade event
 * DISPATCH must not use this (see facade.js): swallowing outbound events is what
 * stranded the overlay in F4.
 */
export function safeCall(fn, where, fallback) {
  if (autoDisabled) return fallback;
  try {
    return fn();
  } catch (err) {
    noteFailure(where, err);
    return fallback;
  }
}

/**
 * All four layers for the capture layer + façade. Returns a human-readable reason string
 * when the feature is off, or null when it may run. Layer 1 first — see the file header.
 */
export function killSwitchReason() {
  if (CONFIG.enableUniversalPlayer !== true) return 'CONFIG.enableUniversalPlayer is false';
  if (typeof window !== 'undefined' && window.__PS_DISABLE) return 'window.__PS_DISABLE is set';
  if (storageKillSwitchSet()) return `localStorage["${KILL_SWITCH_STORAGE_KEY}"] is set`;
  if (autoDisabled) return autoDisableReason;
  return null;
}

export function isUniversalPlayerEnabled() {
  return killSwitchReason() === null;
}

/**
 * Layers 2-4 apply to the Android veto too; only layer 1 differs (it has its own
 * three-valued config knob). Anything other than the two opt-in strings reads as
 * 'never', so a typo fails closed rather than forcing a transcode.
 *
 * F10: layer 1 is tested first here as well. This predicate runs on every 100 ms boot
 * tick, and checking localStorage ahead of it meant ~20 throw/catch cycles a second in a
 * hardened WebView on an install that had the veto switched off anyway.
 */
export function androidVetoMode() {
  const mode = CONFIG.androidForceWebPlayer;
  if (mode !== 'auto' && mode !== 'always') return 'never';
  if (typeof window !== 'undefined' && window.__PS_DISABLE) return 'never';
  if (storageKillSwitchSet()) return 'never';
  if (autoDisabled) return 'never';
  return mode;
}

/** Diagnostics for window.JFPauseScreen.status(). Never throws. */
export function guardStatus() {
  return {
    configEnabled: CONFIG.enableUniversalPlayer === true,
    androidForceWebPlayer: CONFIG.androidForceWebPlayer ?? 'never',
    androidVetoMode: androidVetoMode(),
    windowDisable: !!(typeof window !== 'undefined' && window.__PS_DISABLE),
    storageDisable: storageKillSwitchSet(),
    errorsCaught: thrownCount,
    errorBudget: ERROR_BUDGET,
    autoDisabled,
    lastError,
    inactiveReason: killSwitchReason()
  };
}
