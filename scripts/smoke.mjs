/**
 * SMOKE TEST — G-2. Plain node, no framework, no dependencies: `node scripts/smoke.mjs`.
 * Run it AFTER `npm run build`: §1 asserts invariants about the built artifact.
 *
 * STRUCTURE, and why it is shaped this way. Round 2's harness passed 82 checks and still
 * let four defects through, all of them in the façade <-> pauseScreen SEAM — because it
 * tested the façade in isolation and pauseScreen only by grepping source. §8 closes that:
 * it boots the REAL initPauseScreen() on a minimal DOM (scripts/domshim.mjs) and drives
 * the REAL façade into it, so the ordering and purge behaviour that broke are now
 * observable. Round 1's self-satisfying `makeFakeVideo()` arm and its transcribed copy of
 * updateProgress()'s arithmetic stay deleted; §8 asserts against the real function.
 *
 *   §1  static + dist invariants: browser-path sentinels (F2), DCE contract (F9), and a
 *       string-literal diff against the kept v4.1.1 artifact — a real equivalence check,
 *       where the sentinel count alone is only a count
 *   §2  the Android veto's safety-valve gate (F3), before anything is armed
 *   §3  bounded arming retry when window.Events is late (F1)
 *   §4  veto mechanics: B6 shape detection, 'auto' probing, per-item attribution (F12)
 *   §5  the platform gate (F6)
 *   §6  façade unit behaviour: B1/B2/B3/B4/B7, R1's once-per-item loadedmetadata, R4
 *   §7  capture teardown and item changes: F5, R2, R3
 *   §8  INTEGRATION — real façade into real pauseScreen
 *   §9  Events.trigger wrap discipline: refuse-to-stack, not-outermost, orphan stays dead
 *   §10 all four kill-switch layers and the error-budget teardown (F4) — LAST, because
 *       tripping the budget disables everything process-wide
 */
import fs from 'node:fs';
import { CONFIG } from '../src/config.js';
import { installDomShim, flushRAF } from './domshim.mjs';

// Captured BEFORE any test mutates CONFIG: §1 needs the values the artifact was built with.
const SHIPPED_UNIVERSAL = CONFIG.enableUniversalPlayer;
const SHIPPED_ANDROID_MODE = CONFIG.androidForceWebPlayer;

const SRC = new URL('../src/', import.meta.url);
const DIST = new URL('../dist/js-pause-screen.js', import.meta.url);
const BASELINE = new URL('../Archive/js-pause-screen_v4.1.1.js', import.meta.url);

let failures = 0;
let checks = 0;
let skipped = 0;
const notes = [];

function ok(label, condition, detail) {
  checks += 1;
  if (condition) return;
  failures += 1;
  // Deliberately `realError`, not `console.error`. §8 stubs console.error out for the whole
  // integration section (the fake fetch fails on purpose and that path logs), and when this
  // reported through the stub every §8 failure came out as an unattributed number in the final
  // count — silencing the one section that exists because it is the hardest to reason about.
  realError(`  FAIL  ${label}${detail === undefined ? '' : ` — got ${JSON.stringify(detail)}`}`);
}
function skip(label, why) { skipped += 1; notes.push(`  SKIP  ${label} — ${why}`); }
const flush = () => new Promise(r => setTimeout(r, 0));

const infoLog = [];
const realInfo = console.info;
const realWarn = console.warn;
const realError = console.error;
console.info = (...a) => { infoLog.push(a.join(' ')); };

// ═════════════════════════════════════════════════════════════════════════════════════
// §1 STATIC + DIST INVARIANTS
// ═════════════════════════════════════════════════════════════════════════════════════
const SENTINEL_RE = /0[=!]==[a-zA-Z_$]*\.currentTime|[a-zA-Z_$]*\.currentTime[=!]==0/g;
const STRING_RE = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g;

const pauseScreenSrc = fs.readFileSync(new URL('core/pauseScreen.js', SRC), 'utf8');
ok('F2 source: the 5 original <video> sentinels are present verbatim',
  (pauseScreenSrc.match(/video\.currentTime\s*[!=]==\s*0/g) || []).length === 5);
ok('F2 source: all 5 sentinel sites are polymorphic on the target',
  (pauseScreenSrc.match(/isPauseScreenFacade\(video\)\s*\?/g) || []).length === 5);
ok('F2 source: loadstart/emptied are wired straight to purge, as in v4.1.1',
  pauseScreenSrc.includes("addEventListener('loadstart', purge)")
  && pauseScreenSrc.includes("addEventListener('emptied', purge)"));
ok('R5 source: destroy() removes the wheel listener',
  /destroy\(\)[\s\S]{0,1200}removeEventListener\('wheel', onWheel\)/.test(pauseScreenSrc));

if (!fs.existsSync(DIST)) {
  skip('§1 dist invariants', 'dist/js-pause-screen.js not built — run `npm run build` first');
} else {
  const dist = fs.readFileSync(DIST, 'utf8');
  ok('F2 dist: exactly 5 minified currentTime zero-sentinels survive',
    (dist.match(SENTINEL_RE) || []).length === 5, (dist.match(SENTINEL_RE) || []).length);

  const facadeInDist = dist.includes('facade-currentTime');
  if (SHIPPED_UNIVERSAL === true) ok('F9 dist: façade ships when the flag is on', facadeInDist);
  else ok('F9 dist: façade is dead-code-eliminated when the flag is off', !facadeInDist);

  const vetoInDist = dist.includes('veto-decide');
  if (SHIPPED_ANDROID_MODE === 'never') ok('F9 dist: veto is DCE-d when the mode is "never"', !vetoInDist);
  else ok('F9 dist: veto ships when the mode is enabled', vetoInDist);

  // R6: the sentinel COUNT is not an equivalence — 4x`!==`+1x`===` and 5x`!==` both score
  // 5. A string-literal diff against the kept v4.1.1 artifact is the stronger, equally
  // cheap invariant: every selector, event name, class name, CSS fragment and message the
  // browser path depends on is a literal, so any drift shows up here.
  if (!fs.existsSync(BASELINE)) {
    skip('§1 string-literal parity', 'Archive/js-pause-screen_v4.1.1.js not present (Archive/ is gitignored)');
  } else {
    const base = fs.readFileSync(BASELINE, 'utf8');
    // Quoted fragments INSIDE a template literal (e.g. the `url('${blobUrl}')` wrappers)
    // are not string literals at all — the regex just can't tell. They embed mangled
    // identifier names, which shift whenever module count changes, so comparing them
    // would report pure renames as drift. Dropped from both sides symmetrically.
    const literals = (text) => new Set((text.match(STRING_RE) || []).filter(s => !s.includes('${')));
    const oldLits = literals(base);
    const newLits = literals(dist);
    const removed = [...oldLits].filter(s => !newLits.has(s));
    const added = [...newLits].filter(s => !oldLits.has(s));
    // Only the version string may disappear. Anything else means browser-path text moved.
    ok('R6: no v4.1.1 string literal was removed except the version',
      removed.length === 1 && removed[0] === '"4.1.1"', removed);
    // Everything new must be attributable to this release's new surface.
    const ALLOWED_NEW = new Set([
      '"4.2.0"',                                  // the version bump
      '"jfPauseScreenDisableUniversal"',          // kill-switch layer 3 storage key
      '"CONFIG.enableUniversalPlayer is false"',  // kill-switch layer 1 reason string
      '"true"',                                   // layer 3 accepts '1' or 'true'
      '"never"',                                  // androidForceWebPlayer's default
      '"undefined"'                               // typeof guards in the new modules
    ]);
    const unexplained = added.filter(s => !ALLOWED_NEW.has(s));
    ok('R6: every new string literal is attributable to the new surface', unexplained.length === 0, unexplained);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════
// Environment
// ═════════════════════════════════════════════════════════════════════════════════════
const listenersOf = new WeakMap();
const fakeEvents = {
  on(obj, type, fn) {
    if (!listenersOf.has(obj)) listenersOf.set(obj, new Map());
    const map = listenersOf.get(obj);
    if (!map.has(type)) map.set(type, new Set());
    map.get(type).add(fn);
  },
  trigger(obj, type, args) {
    const set = listenersOf.get(obj)?.get(type);
    if (!set) return;
    for (const fn of [...set]) fn({ type }, ...(args || []));
  }
};

const { document } = installDomShim({
  credentials: { Servers: [{ AccessToken: 'tok', UserId: 'usr', ManualAddress: 'http://localhost' }] },
  playableMimes: [
    'video/mp4; codecs="avc1.42E01E"', 'audio/mp4; codecs="mp4a.40.2"',
    'video/webm; codecs="vp9"', 'audio/webm; codecs="opus"'
  ]
});
globalThis.window.Events = fakeEvents;

function makeExoPlayerPlugin() {
  return {
    type: 'mediaplayer', id: 'exoplayervideo', priority: -1,
    play() {}, stop() {}, canPlayMediaType() { return true; }
  };
}
const directPlayItem = (Id) => ({
  Id,
  MediaSources: [{
    Container: 'mp4', SupportsDirectPlay: true,
    MediaStreams: [{ Type: 'Video', Codec: 'h264' }, { Type: 'Audio', Codec: 'aac' }]
  }]
});
const transcodeItem = (Id) => ({
  Id,
  MediaSources: [{
    Container: 'mkv', SupportsDirectPlay: true,
    MediaStreams: [{ Type: 'Video', Codec: 'hevc' }, { Type: 'Audio', Codec: 'ac3' }]
  }]
});
const noStreamsItem = (Id) => ({ Id, MediaSources: [{ Container: 'mp4', SupportsDirectPlay: true }] });

/**
 * An mpv-shaped Jellyfin player: MILLISECONDS, `undefined` before the first tick, and — by
 * default — a paused() that will not answer, which is exactly the B4 behaviour R4 turned
 * on. Tests that need a cooperative player set `_reportPaused = true`.
 */
function makeJellyfinPlayer() {
  const self = {
    _ms: undefined, _durMs: undefined, _paused: false, _reportPaused: false,
    currentTime(ms) { if (ms === undefined) return self._ms; self._ms = ms; },
    duration() { return self._durMs; },
    paused() { return self._reportPaused ? self._paused : undefined; },
    pause() { self._paused = true; fakeEvents.trigger(self, 'pause'); },
    unpause() { self._paused = false; fakeEvents.trigger(self, 'unpause'); /* undefined — B2 */ },
    play() { throw new Error('play() starts a NEW item; the façade must never call it'); },
    stop() {},
    __tick(ms) { self._ms = ms; fakeEvents.trigger(self, 'timeupdate'); }
  };
  return self;
}
const playbackManager = {
  currentItem() { return null; }, getPlayerInfo() { return {}; }, isPlayingVideo() { return true; }
};

const detect = await import('../src/services/players/detect.js');
const veto = await import('../src/services/players/androidVeto.js');

// ═════════════════════════════════════════════════════════════════════════════════════
// §2 F3 — the veto must NOT install while its safety valve is missing
// ═════════════════════════════════════════════════════════════════════════════════════
CONFIG.androidForceWebPlayer = 'always';
const exo = makeExoPlayerPlugin();
globalThis.window.ExoPlayer = exo;

ok('F3: no playbackerror observer before arming', detect.isPlaybackErrorObserved() === false);
veto.scanAndVeto();
ok('F3: veto refuses to patch without its safety valve', veto.vetoStatus().pluginsPatched === 0);
ok('F3: the plugin is genuinely untouched', exo.canPlayItem === undefined);

// ═════════════════════════════════════════════════════════════════════════════════════
// §3 F1 — arming retries, bounded, and stays silent while it is only "not yet"
// ═════════════════════════════════════════════════════════════════════════════════════
const realEvents = globalThis.window.Events;
delete globalThis.window.Events; // jellyfin-web has not booted yet (async script, warm cache)
CONFIG.enableUniversalPlayer = true;
detect.armPlayerCapture();
ok('F1: first arm attempt recorded, not fatal', detect.detectStatus().armAttempts === 1);
detect.armPlayerCapture();
detect.armPlayerCapture();
ok('F1: arming keeps retrying while window.Events is absent', detect.detectStatus().armAttempts === 3,
  detect.detectStatus().armAttempts);
ok('F1: has not given up', detect.detectStatus().armGaveUp === false);
ok('F1: no console.info burned on a retryable condition', infoLog.length === 0, infoLog);
ok('F1: no wrap installed while Events is missing', detect.detectStatus().triggerWrapActive === false);

globalThis.window.Events = realEvents;
const pristineTrigger = fakeEvents.trigger;
detect.armPlayerCapture();
ok('F1: arms as soon as window.Events appears', detect.detectStatus().triggerWrapActive === true);
ok('F1: safety valve is now observed', detect.isPlaybackErrorObserved() === true);

const thrower = {};
fakeEvents.on(thrower, 'boom', () => { throw new Error('upstream'); });
let propagated = false;
try { fakeEvents.trigger(thrower, 'boom'); } catch { propagated = true; }
ok('wrap: a subscriber throw still propagates (try/finally, not try/catch)', propagated);

// ═════════════════════════════════════════════════════════════════════════════════════
// §4 Veto mechanics — B6, 'auto' probing, F12 attribution
// ═════════════════════════════════════════════════════════════════════════════════════
globalThis.window.ExternalPlayer = { isEnabled: () => true, initPlayer: () => {} }; // native bridge
CONFIG.androidVetoExternalPlayer = true; // consider it, so B6 rejects it on SHAPE not policy
veto.scanAndVeto();
ok('F3: veto installs once the safety valve exists', veto.vetoStatus().pluginsPatched === 1);
ok('B6: the native bridge was NOT patched', globalThis.window.ExternalPlayer.canPlayItem === undefined);
ok('B6: the plugin instance WAS patched', typeof exo.canPlayItem === 'function');

ok("veto 'always': every item is vetoed", exo.canPlayItem(transcodeItem('mkv1')) === false);
CONFIG.androidForceWebPlayer = 'auto';
ok("veto 'auto': a direct-playable item IS vetoed", exo.canPlayItem(directPlayItem('mp4a')) === false);
ok("veto 'auto': an MKV/HEVC item is NOT vetoed", exo.canPlayItem(transcodeItem('mkv2')) === true);
ok('F12: an item with no MediaStreams fails closed (not vetoed)',
  exo.canPlayItem(noStreamsItem('bare')) === true);

exo.canPlayItem(directPlayItem('itemA'));
fakeEvents.trigger(playbackManager, 'playbackerror', ['MediaDecodeError']);
ok('§3: a failed vetoed item is suspended', veto.vetoStatus().suspendedItems === 1);
ok('§3: the suspended item now falls back to the native player',
  exo.canPlayItem(directPlayItem('itemA')) === true);
exo.canPlayItem(transcodeItem('itemB'));
fakeEvents.trigger(playbackManager, 'playbackerror', ['MediaDecodeError']);
ok('F12: a failure after a non-veto decision suspends nothing', veto.vetoStatus().suspendedItems === 1);

CONFIG.androidForceWebPlayer = 'never';
ok("veto 'never' restores native selection", exo.canPlayItem(directPlayItem('mp4b')) === true);

// ═════════════════════════════════════════════════════════════════════════════════════
// §5 F6 — the platform gate
// ═════════════════════════════════════════════════════════════════════════════════════
let captureNotifications = 0;
detect.armPlayerCapture(() => { captureNotifications += 1; });

const player = makeJellyfinPlayer();
captureNotifications = 0;
fakeEvents.trigger(playbackManager, 'playbackstart', [player, { NowPlayingItem: { Id: 'abc' } }]);
ok('route C: player captured', detect.detectStatus().playerCaptured === true);
ok('route C: playbackManager captured', detect.detectStatus().playbackManagerCaptured === true);
ok('F3: the wrap only stood down once the manager subscription existed',
  fakeEvents.trigger === pristineTrigger);
ok('R3: exactly one capture notification per playbackstart', captureNotifications === 1, captureNotifications);

ok('F6: no façade without window.jmpInfo — Android must never get one',
  detect.detectPlayerTarget() === null);
ok('F6: status reports the platform as unsupported', detect.detectStatus().platformSupported === false);

globalThis.window.jmpInfo = { version: '2.0.0' }; // jellyfin-desktop
const facade = detect.detectPlayerTarget();
ok('F6: façade is built on jellyfin-desktop', !!facade && facade.__isPauseScreenFacade === true);
ok('façade identity is stable across calls', detect.detectPlayerTarget() === facade);
ok('route C: item id override exposed', facade.psItemId === 'abc');
ok('façade: getAttribute("poster") is null', facade.getAttribute('poster') === null);

// ═════════════════════════════════════════════════════════════════════════════════════
// §6 Façade unit behaviour
// ═════════════════════════════════════════════════════════════════════════════════════
const seen = [];
for (const t of ['loadstart', 'emptied', 'ended', 'pause', 'play', 'seeked', 'loadedmetadata']) {
  facade.addEventListener(t, () => seen.push(t));
}

ok('B4: currentTime is a finite 0 before the first tick', facade.currentTime === 0, facade.currentTime);
ok('B4: duration is 0, not NaN, before metadata', facade.duration === 0, facade.duration);
// R1: readyState is keyed to the ITEM being announced, not to duration being known — a
// façade only exists after a live playbackstart, so the prefetch should run at bind time.
ok('R1: readyState is >= 1 at construction, before any duration', facade.readyState >= 1);

// R1 — THE ORDERING CASE. Pause with the duration still unknown, which is the normal mpv
// situation for the first ~500 ms of an item. `loadedmetadata` must NOT appear here: its
// consumer opens with purge(), and nothing would follow to rebuild the overlay.
player.pause();
await flush();
ok('R1: pause with unknown duration dispatches pause', seen.includes('pause'), seen);
ok('R1: and does NOT dispatch loadedmetadata', !seen.includes('loadedmetadata'), seen);
player._durMs = 600000;
player.__tick(1000);
await flush();
ok('R1: duration arriving late still does NOT dispatch loadedmetadata', !seen.includes('loadedmetadata'), seen);
ok('R1: it dispatches seeked instead, so a visible overlay redraws', seen.includes('seeked'), seen);
ok('B1: duration converts ms -> s exactly once', facade.duration === 600, facade.duration);

// R4 — resume signalled ONLY by 'playing', on a player whose paused() will not answer.
const playsBefore = seen.filter(t => t === 'play').length;
fakeEvents.trigger(player, 'playing');
ok('R4: a resume via "playing" alone is honoured when paused() is unreadable',
  seen.filter(t => t === 'play').length === playsBefore + 1, seen);
ok('R4: paused reads false afterwards', facade.paused === false);

// F8's original case still holds: a player that DOES answer, and answers "paused".
player._reportPaused = true;
player.pause();
const playsBefore2 = seen.filter(t => t === 'play').length;
fakeEvents.trigger(player, 'playing');
ok('F8: "playing" is ignored when the player confirms it is still paused',
  seen.filter(t => t === 'play').length === playsBefore2, seen);
player._reportPaused = false;

// B3 / B1 / B7 — seeking.
facade.currentTime = 300;
await flush();
ok('B3: seek writes straight to the player, in ms', player._ms === 300000, player._ms);
ok('B3: position reads back in seconds', facade.currentTime === 300, facade.currentTime);
facade.currentTime = 400;
player._ms = 120000; // mpv's ~2 Hz cache still reporting the PRE-seek position
ok('B7: a stale position read does not clobber the seek', facade.currentTime === 400, facade.currentTime);
player._ms = 400000;
ok('B7: the settled position is accepted', facade.currentTime === 400);
player._ms = 405000;
ok('B7: normal ticks resume after the seek settles', facade.currentTime === 405, facade.currentTime);

// B2 — three call sites do video.play().catch(...), and unpause() returns undefined.
const resumed = facade.play();
ok('B2: play() returns a thenable', !!resumed && typeof resumed.then === 'function');
await resumed.catch(() => {});

// ═════════════════════════════════════════════════════════════════════════════════════
// §7 F5 / R2 / R3 — stop, restart, and item changes
// ═════════════════════════════════════════════════════════════════════════════════════
fakeEvents.trigger(playbackManager, 'playbackstop');
ok('F5: capture is cleared on playbackstop', detect.detectStatus().playerCaptured === false);
ok('F5: detectPlayerTarget returns null so main.js can destroy the instance',
  detect.detectPlayerTarget() === null);

// R2 — the episode transition. stop -> start on the SAME player must still reach
// __onPlaybackStart(), even though clearCapture() nulled `captured` in between.
seen.length = 0;
captureNotifications = 0;
// The boot tick keeps calling armPlayerCapture(). That is what made R3 reachable: with
// `captured` nulled by the stop, the old gate happily re-wrapped Events.trigger even
// though the manager subscription was already live, and then BOTH fired.
detect.armPlayerCapture();
ok('R3: a boot tick after a stop does not re-wrap Events.trigger',
  fakeEvents.trigger === pristineTrigger);
fakeEvents.trigger(playbackManager, 'playbackstart', [player, { NowPlayingItem: { Id: 'def' } }]);
await flush();
ok('R2: a stop -> start item change runs __onPlaybackStart (loadstart reaches the consumer)',
  seen.includes('loadstart'), seen);
ok('R2: and announces loadedmetadata for the new item', seen.includes('loadedmetadata'), seen);
ok('R2: loadstart precedes loadedmetadata', seen.indexOf('loadstart') < seen.indexOf('loadedmetadata'), seen);
ok('R2: the item id advanced', facade.psItemId === 'def', facade.psItemId);
ok('R3: still exactly one capture notification per playbackstart', captureNotifications === 1,
  captureNotifications);
ok('R3: the trigger wrap was not re-armed after the stop', detect.detectStatus().triggerWrapActive === false);
ok('F5: the façade is available again', detect.detectPlayerTarget() === facade);

// R1 — loadedmetadata is announced at most ONCE per item.
seen.length = 0;
player._durMs = 900000;
player.__tick(2000);
await flush();
ok('R1: no second loadedmetadata within the same item', !seen.includes('loadedmetadata'), seen);

// R4 on the ITEM-CHANGE path. The previous item ended while paused, so pausedMirror is
// true; on mpv paused() will not say otherwise. Reading the mirror there concludes the new
// item started paused, so no `play` is dispatched, pausedMirror stays true for the whole
// item, and facade.paused then lies to onGlobalScreenTap and onSeeked.
player.pause();
await flush();
seen.length = 0;
fakeEvents.trigger(playbackManager, 'playbackstop');
detect.armPlayerCapture();
fakeEvents.trigger(playbackManager, 'playbackstart', [player, { NowPlayingItem: { Id: 'ghi' } }]);
await flush();
ok('R4: a new item starting after a PAUSED stop still dispatches play', seen.includes('play'), seen);
ok('R4: and facade.paused reports playing, not the stale mirror', facade.paused === false, facade.paused);

// ═════════════════════════════════════════════════════════════════════════════════════
// §8 INTEGRATION — the real façade driven into the real pauseScreen
// ═════════════════════════════════════════════════════════════════════════════════════
const { initPauseScreen } = await import('../src/core/pauseScreen.js');

// A fresh player, so this is a first capture and the façade is built from scratch.
const p2 = makeJellyfinPlayer();
fakeEvents.trigger(playbackManager, 'playbackstart', [p2, { NowPlayingItem: { Id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }]);
const facade2 = detect.detectPlayerTarget();
ok('integration: a façade exists for the new player', !!facade2 && facade2 !== facade);

console.error = () => {}; // the stubbed fetch fails on purpose; that path logs
const instance = initPauseScreen();
ok('integration: pauseScreen bound to the façade, not to a <video>', instance.getVideo() === facade2);

const overlayEl = document.getElementById('pause-overlay');
ok('integration: the overlay exists in the DOM', !!overlayEl);

// The core R1 scenario, end to end: pause while mpv has not published a duration.
p2.pause();
await flush();
flushRAF();
await flush();
ok('R1 integration: the overlay is displayed after a pause with unknown duration',
  overlayEl.style.display === 'block', overlayEl.style.display);
ok('R1 integration: it is still displayed after the microtask queue drains',
  overlayEl.style.display === 'block', overlayEl.style.display);
ok('R1 integration: and it was actually made visible, not left mid-render',
  overlayEl.style.visibility === 'visible', overlayEl.style.visibility);

// Progress must degrade gracefully with no duration — this is the REAL updateProgress().
const fill = overlayEl.querySelector('.ps-progress-fill');
const pct = overlayEl.querySelector('.ps-progress-pct');
ok('R1 integration: progress reads "Duration unavailable" rather than NaN',
  pct.textContent === 'Duration unavailable', pct.textContent);
ok('R1 integration: the bar width is 0%, never NaN%', fill.style.width === '0%', fill.style.width);

// Duration lands late. The overlay must survive it AND repair its own readout.
p2._ms = 300000;
p2._durMs = 600000;
p2.__tick(300000);
await flush();
flushRAF();
ok('R1 integration: the visible overlay SURVIVES a late duration',
  overlayEl.style.display === 'block', overlayEl.style.display);
ok('R1 integration: and the real updateProgress() repaired the bar to 50%',
  fill.style.width === '50%', fill.style.width);
ok('R1 integration: the percentage text repaired too', pct.textContent === '50% watched', pct.textContent);

// R2 end to end: the next episode must clear the previous episode's rendered metadata.
const titleEl = overlayEl.querySelector('.ps-title');
titleEl.textContent = 'PREVIOUS EPISODE';
fakeEvents.trigger(playbackManager, 'playbackstop');
fakeEvents.trigger(playbackManager, 'playbackstart', [p2, { NowPlayingItem: { Id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } }]);
await flush();
flushRAF();
ok('R2 integration: the previous episode\'s title was purged from the overlay',
  titleEl.textContent === '', titleEl.textContent);
ok('R2 integration: the façade reports the new item id',
  facade2.psItemId === 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

// R4 end to end: resume via 'playing' alone must take the overlay down.
p2.pause();
await flush();
flushRAF();
ok('R4 integration: overlay is up after pause', overlayEl.style.display === 'block');
fakeEvents.trigger(p2, 'playing');
await flush();
ok('R4 integration: a resume signalled only by "playing" hides the overlay',
  overlayEl.style.opacity === '0', overlayEl.style.opacity);

// R1 RESIDUAL: a purge landing between showOverlay() scheduling its frames and those
// frames running must not resurrect the overlay. Without the isOverlayVisible re-checks,
// the chain paints visibility:visible + opacity:1 onto a display:none element, and the
// later hideOverlay() early-returns on !isOverlayVisible so they are never taken off.
fakeEvents.trigger(p2, 'playing');
await flush();
p2.pause();                       // showOverlay() -> display:block, visibility:hidden, rAF queued
await flush();
fakeEvents.trigger(p2, 'stopped'); // -> 'emptied' -> purge() -> resetOverlayState()
ok('R1 residual: purge takes the overlay down', overlayEl.style.display === 'none',
  overlayEl.style.display);
flushRAF();
ok('R1 residual: the pending rAF chain does not resurrect a purged overlay',
  overlayEl.style.display === 'none', overlayEl.style.display);
ok('R1 residual: and does not leave visibility:visible stranded on it',
  overlayEl.style.visibility !== 'visible', overlayEl.style.visibility);

// R5: destroy() must leave no document-level listeners behind.
p2.pause();
await flush();
ok('R5: a wheel listener is registered while paused', document.listenerCount('wheel') === 1,
  document.listenerCount('wheel'));
instance.destroy();
ok('R5: destroy() removes the wheel listener', document.listenerCount('wheel') === 0,
  document.listenerCount('wheel'));
ok('R5: destroy() removes the keydown listener', document.listenerCount('keydown') === 0,
  document.listenerCount('keydown'));
ok('R5: destroy() removes the pointermove listener', document.listenerCount('pointermove') === 0,
  document.listenerCount('pointermove'));
ok('integration: destroy() removes the overlay from the DOM', !document.getElementById('pause-overlay'));
console.error = realError;

// ═════════════════════════════════════════════════════════════════════════════════════
// §9 Wrap discipline, on isolated module instances (?query gives fresh module state)
// ═════════════════════════════════════════════════════════════════════════════════════
{
  const detectB = await import('../src/services/players/detect.js?stack');
  const foreign = function stackedByAnotherUserscript() {};
  foreign.__jfPauseScreenTriggerWrap = true;
  const saved = fakeEvents.trigger;
  fakeEvents.trigger = foreign;
  detectB.armPlayerCapture();
  ok('wrap: refuses to stack on an existing copy of our own wrapper',
    detectB.detectStatus().triggerWrapActive === false);
  ok('wrap: refusing to stack is terminal and does log', infoLog.length === 1, infoLog);
  ok('wrap: the other copy is left untouched', fakeEvents.trigger === foreign);
  fakeEvents.trigger = saved;
}
{
  const detectC = await import('../src/services/players/detect.js?outer');
  const saved = fakeEvents.trigger;
  detectC.armPlayerCapture();
  const ours = fakeEvents.trigger;
  ok('wrap: installed', ours !== saved);
  let foreignCalls = 0;
  const outermost = function anotherUserscript(obj, type, args) {
    foreignCalls += 1;
    return ours.call(this, obj, type, args);
  };
  fakeEvents.trigger = outermost;
  const p3 = makeJellyfinPlayer();
  fakeEvents.trigger(playbackManager, 'playbackstart', [p3, { NowPlayingItem: { Id: 'zzz' } }]);
  ok('wrap: does NOT restore when no longer outermost — that would delete their hook',
    fakeEvents.trigger === outermost);
  ok('wrap: reports itself orphaned rather than active',
    detectC.detectStatus().triggerWrapOrphaned === true && detectC.detectStatus().triggerWrapActive === false);
  // R3: the orphan must stay dead. Re-arming can no longer revive it, both because
  // subscribedManager gates the re-arm and because liveness is per-closure.
  const notifiesBefore = detectC.detectStatus().capturedItemId;
  detectC.armPlayerCapture();
  fakeEvents.trigger(playbackManager, 'playbackstart', [p3, { NowPlayingItem: { Id: 'yyy' } }]);
  ok('R3: a re-arm attempt after capture does not install a second wrapper',
    fakeEvents.trigger === outermost);
  ok('R3: the orphaned wrapper is not revived (item id still advances only once)',
    detectC.detectStatus().capturedItemId === 'yyy' && notifiesBefore === 'zzz');
  fakeEvents.trigger = saved;
}

// ═════════════════════════════════════════════════════════════════════════════════════
// §10 Kill switches. LAST: layer 4 disables the feature for the rest of the process.
// ═════════════════════════════════════════════════════════════════════════════════════
const guard = await import('../src/services/players/guard.js');
let storageValue = null;
globalThis.localStorage = { getItem: () => storageValue };

CONFIG.enableUniversalPlayer = false;
ok('layer 1: build config', guard.killSwitchReason() === 'CONFIG.enableUniversalPlayer is false');
CONFIG.enableUniversalPlayer = true;
ok('all layers clear: enabled', guard.killSwitchReason() === null, guard.killSwitchReason());

globalThis.window.__PS_DISABLE = true;
ok('layer 2: window.__PS_DISABLE', guard.killSwitchReason() === 'window.__PS_DISABLE is set');
CONFIG.androidForceWebPlayer = 'auto';
ok('layer 2 also gates the veto', guard.androidVetoMode() === 'never');
delete globalThis.window.__PS_DISABLE;

storageValue = '1';
ok('layer 3: localStorage', guard.killSwitchReason().startsWith('localStorage['));
ok('layer 3 also gates the veto', guard.androidVetoMode() === 'never');
storageValue = null;

CONFIG.androidForceWebPlayer = 'never';
let storageReads = 0;
globalThis.localStorage = { getItem: () => { storageReads += 1; return null; } };
for (let i = 0; i < 50; i++) guard.androidVetoMode();
ok('F10: androidVetoMode short-circuits on layer 1 without touching localStorage',
  storageReads === 0, storageReads);

let tornDown = 0;
guard.onAutoDisable(() => { tornDown += 1; });
ok('layer 4: not disabled at 0 errors', guard.guardStatus().autoDisabled === false);
guard.noteFailure('smoke', new Error('one'));
guard.noteFailure('smoke', new Error('two'));
ok('layer 4: budget is 3, still alive at 2', guard.guardStatus().autoDisabled === false);
guard.noteFailure('smoke', new Error('three'));
ok('layer 4: budget exhausted at 3', guard.guardStatus().autoDisabled === true);
ok('layer 4: feature reports itself off', guard.isUniversalPlayerEnabled() === false);
await flush();
ok('F4: auto-disable TEARS DOWN rather than freezing', tornDown === 1, tornDown);

console.info = realInfo;
console.warn = realWarn;
for (const n of notes) console.log(n);
console.log(failures === 0
  ? `\nsmoke: ${checks} checks passed${skipped ? `, ${skipped} skipped` : ''}`
  : `\nsmoke: ${failures} of ${checks} checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
