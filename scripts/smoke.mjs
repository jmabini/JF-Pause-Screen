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
 *   §1  static + dist invariants: dist FRESHNESS (G4), browser-path sentinels (F2), the
 *       DCE contract (F9), and a string-literal diff against the kept v4.1.1 artifact —
 *       a real equivalence check, where the sentinel count alone is only a count
 *   §2  the Android veto's safety-valve gate (F3), before anything is armed
 *   §3  bounded arming retry when window.Events is late (F1)
 *   §4  veto mechanics: B6 shape detection, the ANDROID PLATFORM GATE, 'auto' probing,
 *       the bit-depth and HEVC-level guards, stream/source selection, per-item attribution
 *       (F12), and the persisted-suspension store
 *   §4d the guards nothing was watching. Every check in that section exists because a
 *       faithful mutation of the thing it covers SURVIVED the previous 206: the HTML5
 *       fallback guard, the external-player opt-in, the runtime kill switches acting on an
 *       already-patched plugin, canPlayItem's fail-closed default, B6's `type` field (the
 *       method trio alone was doing all the observable work), and 'always' mode's two
 *       untested obligations — honouring a suspension, and recording why it vetoed
 *
 * EVERY CHECK ADDED IN THE ROUND-7 AUDIT WAS CONFIRMED BY RUNNING ITS MUTATION, not by
 * assertion. Two mutations flagged for coverage turned out to be genuinely EQUIVALENT and
 * were deliberately left uncovered rather than padded around: dropping
 * `typeof at !== 'number'` from the load filter (Number.isFinite in suspensionIsLive()
 * already refuses every string) and swapping the two properties of the decision literal
 * (the literal aborts whole either way). Both are documented at their sites in
 * androidVeto.js. Two checks labelled "refused at LOAD" were deleted in the same round for
 * the opposite reason — they observed through the READ predicate and passed with the load
 * guard removed, so the label was the only thing load-bearing about them.
 *   §5  the façade's platform gate (F6)
 *
 * THE ENGINE MODEL IS A MEASUREMENT, NOT A BELIEF. Round 4's harness passed 140 checks
 * while encoding a false premise ("Chromium has no video/x-matroska entry") that the code
 * had been built on, and it would have gone red on the correct fix. The model below is
 * therefore a transcription of real Chrome 152 / Brave answers that ASSERTS IT REPRODUCES
 * EVERY MEASURED ROW before any veto test is allowed to run.
 *   §6  façade unit behaviour: B1/B2/B3/B4/B7, R1's once-per-item loadedmetadata, R4
 *   §7  capture teardown and item changes: F5, R2, R3
 *   §8  INTEGRATION — real façade into real pauseScreen
 *   §9  Events.trigger wrap discipline: refuse-to-stack, not-outermost, orphan stays dead
 *   §10 all four kill-switch layers and the error-budget teardown (F4) — LAST, because
 *       tripping the budget disables everything process-wide
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { installDomShim, flushRAF, UA_ANDROID_WEBVIEW } from './domshim.mjs';

/** Non-Android UAs, for the veto's platform gate. */
const UA_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) JellyfinMediaPlayer/1.12.0 Chrome/128.0.0.0 Safari/537.36';
const UA_IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';

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

  // ── G4 — DIST FRESHNESS, and why its absence produced a FALSE "caught" signal ───────
  //
  // R6 below derives its allowed-literal set from src/. So any mutation that DELETES a
  // source literal leaves the same literal still present in a stale dist/, where it is
  // now unattributable — and R6 goes red. That reads in a mutation report as "the harness
  // caught it", when what it actually caught is that dist/ was not rebuilt. Every
  // src-mutation would score as caught and the mutation score would be meaningless.
  // These two checks make an R6 failure mean what it says.
  const distMtime = fs.statSync(DIST).mtimeMs;
  const srcDir = fileURLToPath(SRC);
  const stale = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && fs.statSync(full).mtimeMs > distMtime) {
        stale.push(path.relative(srcDir, full));
      }
    }
  })(srcDir);
  for (const extra of ['vite.config.js', 'package.json']) {
    const full = fileURLToPath(new URL('../' + extra, import.meta.url));
    if (fs.existsSync(full) && fs.statSync(full).mtimeMs > distMtime) stale.push(extra);
  }
  ok('G4 dist freshness: nothing dist/ is built from is newer than dist/ — run `npm run build`',
    stale.length === 0, stale);
  // A second, mtime-independent freshness signal: a stale artifact carries a stale version.
  ok('G4 dist freshness: dist/ carries the current CONFIG.version',
    dist.includes(`"${CONFIG.version}"`), CONFIG.version);

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
  if (stale.length > 0) {
    // R6 derives its allowed set from src/, so on a STALE dist/ every literal a source
    // mutation deleted is still in the artifact and still unattributable — R6 goes red and
    // an automated "any red = killed" scorer records a kill that never happened. G4 above
    // already reports the staleness and is attributable to a human who forgot to build;
    // R6 must not double-report it as a code defect.
    skip('§1 string-literal parity (R6)',
      'dist/ is stale — G4 already reported it; R6 on a stale artifact is not a code signal');
  } else if (!fs.existsSync(BASELINE)) {
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
    // Everything new must be attributable to this release's new surface. What counts as
    // "the new surface" depends on whether the feature actually shipped — with the flag
    // off terser strips it and only a handful of guard strings survive, with it on the
    // whole players/* vocabulary is legitimately present. Deriving the allowed set from
    // the new SOURCE FILES rather than hardcoding it means this check keeps working when
    // the flag flips, and still fails on a literal that came from nowhere.
    const unquote = (s) => s.slice(1, -1);
    const allowedContents = new Set([
      CONFIG.version,                             // the version bump
      'jfPauseScreenDisableUniversal',            // kill-switch layer 3 storage key
      'CONFIG.enableUniversalPlayer is false',    // kill-switch layer 1 reason string
      'true',                                     // layer 3 accepts '1' or 'true'
      'never',                                    // androidForceWebPlayer's default
      'undefined'                                 // typeof guards in the new modules
    ]);
    // Mirror the code's real arming condition, not just the universal flag. The two flags
    // strip independently: `enableUniversalPlayer: false` is a boolean terser can fold, so
    // the façade goes — but `androidForceWebPlayer` is a STRING, so anything other than a
    // folded-away comparison keeps the veto AND the capture layer (which arms for either
    // feature) in the bundle. Keying this on the universal flag alone reported the veto's
    // whole vocabulary as unexplained drift in an android-only build.
    if (SHIPPED_UNIVERSAL === true || SHIPPED_ANDROID_MODE !== 'never') {
      // Harvest every literal the new modules actually contain. A dist literal is
      // attributable only if some new source file genuinely spells it.
      for (const f of ['services/players/guard.js', 'services/players/detect.js',
                       'services/players/facade.js', 'services/players/androidVeto.js']) {
        const src = fs.readFileSync(new URL(f, SRC), 'utf8');
        for (const lit of src.match(STRING_RE) || []) {
          if (!lit.includes('${')) allowedContents.add(unquote(lit));
        }
      }
    }
    const unexplained = added.filter(s => !allowedContents.has(unquote(s)));
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

// ═════════════════════════════════════════════════════════════════════════════════════
// THE ENGINE MODEL — a transcription of MEASURED canPlayType answers (G1)
// ═════════════════════════════════════════════════════════════════════════════════════
/**
 * The previous model had two structural defects, and the first one WAS the bug.
 *
 *  1. `speaks` omitted 'video/x-matroska'. That single omission encoded the source's false
 *     premise into the harness, so the harness agreed with the code instead of checking
 *     it — and would have gone red on the correct fix.
 *  2. `decodes` was ONE flat, container-agnostic Set, so the model could not express
 *     per-container codec support. Real Chromium is emphatically per-container: `vp9` is
 *     accepted in webm and refused in matroska, `vorbis` is accepted in webm and matroska
 *     and refused in mp4. A flat set cannot represent the VP9 bug at all, which is why
 *     that bug shipped past 140 green checks.
 *
 * So: an engine is `containerMIME -> [acceptor predicates]`. A predicate rather than a
 * literal set because canPlayType parses for a FAMILY token; see hevc() below, which is
 * where the whole "the engine will not do this for you" argument lives.
 */
let engine = null;
function modelEngine(mime) {
  const [container, codecPart] = String(mime).split(';');
  const acceptors = engine[container.trim()];
  if (!acceptors) return '';                       // no entry for this MIME at all
  if (codecPart === undefined) return 'maybe';     // container known, codecs unstated
  const ids = (codecPart.match(/codecs="([^"]*)"/) || [, ''])[1]
    .split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length === 0) return 'maybe';
  return ids.every(id => acceptors.some(fn => fn(id))) ? 'probably' : '';
}

const lit = (...ids) => { const set = new Set(ids); return (id) => set.has(id); };
/** H.264: any 6-hex profile/constraint/level triplet, INCLUDING High 10 (avc1.6E….). */
const avc = (id) => /^avc1\.[0-9A-Fa-f]{6}$/.test(id);
/** AV1: profile/level/tier/depth. Both `.08` and `.10` were measured "probably". */
const av1 = (id) => /^av01\.\d+\.\d{2}[MH]\.\d{2}$/.test(id);
/** VP9's FULL form. The legacy short form is webm-only and is spelled out per container. */
const vp09 = (id) => /^vp09\.\d{2}\.\d{2}\.\d{2}$/.test(id);
/**
 * HEVC, and the single most important line in this file.
 *
 * The engine recognises the PROFILE TOKEN (1.6 = Main, 2.4 = Main 10) and then answers
 * about the family. It does NOT validate the level: L4, L29 and L153.5 were all measured
 * "probably". The only level it refuses is one that cannot fit general_level_idc, a byte
 * — L1000 measured "". That is why androidVeto.js has to range-check the level itself,
 * and why the harness must model an engine that WILL say yes to a nonsense level: a model
 * that helpfully rejected L4 would hide the deletion of that range check.
 *
 * `[LH]` covers the high tier; only the L tier was measured. `.B0` is the constraint
 * suffix every id this project emits carries.
 *
 * SCOPE, stated so it cannot be mistaken for a measurement: this models the two profile
 * tokens androidVeto.js can EMIT — `1.6` (Main) and `2.4` (Main 10). Other tokens exist
 * (`4.10` is Rext, and a reviewer measured real Chrome answering "probably" to
 * `hvc1.4.10.L153.B0`), and this predicate returns '' for all of them. That is a scope
 * boundary, not a claim about the engine: nothing in this project builds such an id, so no
 * check may depend on the answer. Widen the model only alongside a codec map that emits it.
 */
function hevc(id) {
  const m = /^(?:hvc1|hev1)\.(?:1\.6|2\.4)\.[LH](\d+)(?:\.\d+)?\.B0$/.exec(id);
  return !!m && Number(m[1]) <= 255;
}

/** Real Chrome 152 / Brave, headless=new, GPU ENABLED, macOS. Both engines identical. */
const CHROMIUM = {
  'video/x-matroska': [avc, hevc, av1, vp09,
    lit('vp8', 'mp4a.40.2', 'mp3', 'flac', 'opus', 'vorbis')],
  'video/mp4': [avc, hevc, av1, vp09, lit('mp4a.40.2', 'mp3', 'flac', 'opus')],
  'video/webm': [vp09, lit('vp8', 'vp9', 'opus', 'vorbis')],
  // Bare only. The codec list here used to say theora/vorbis/opus; that was never measured
  // and the theora half is wrong — Chrome dropped Theora and a reviewer measured '' for it.
  // `ogv` is not in CONTAINER_MIMES, so nothing asks a codec question of this container;
  // an empty acceptor list keeps the measured bare "maybe" and asserts nothing else.
  'video/ogg': []
  // Deliberately absent, all measured "": video/quicktime, video/mp2t, and of course
  // video/x-total-nonsense. ac-3/ec-3/dts appear in NO container: desktop Chromium has no
  // Dolby or DTS decoder. Entries not pinned by the table below (vorbis, and mp4's
  // mp3/flac/opus) are extrapolation and are marked as such — no check may depend on them.
};

/**
 * MEASURED GROUND TRUTH, captured 2026-09-07. Do not edit a row to make a test pass; the
 * only legitimate reason to change one is a fresh measurement on a real engine.
 */
const MEASURED = [
  ['video/x-matroska', 'maybe'],
  ['video/x-matroska; codecs="avc1.42E01E,mp4a.40.2"', 'probably'],
  ['video/x-matroska; codecs="avc1.42E01E"', 'probably'],
  ['video/x-matroska; codecs="mp4a.40.2"', 'probably'],
  ['video/x-matroska; codecs="hvc1.1.6.L93.B0"', 'probably'],
  ['video/x-matroska; codecs="av01.0.05M.08"', 'probably'],
  ['video/x-matroska; codecs="avc1.42E01E,flac"', 'probably'],
  ['video/x-matroska; codecs="avc1.42E01E,opus"', 'probably'],
  ['video/x-matroska; codecs="avc1.42E01E,mp3"', 'probably'],
  ['video/x-matroska; codecs="vp8"', 'probably'],
  ['video/x-matroska; codecs="vp9"', ''],                   // short form rejected in mkv
  ['video/x-matroska; codecs="vp9,opus"', ''],
  ['video/x-matroska; codecs="vp09.00.10.08"', 'probably'],
  ['video/x-matroska; codecs="vp09.02.51.10"', 'probably'],
  ['video/x-matroska; codecs="avc1.42E01E,ac-3"', ''],
  ['video/x-matroska; codecs="avc1.42E01E,ec-3"', ''],
  ['video/x-matroska; codecs="avc1.42E01E,dts"', ''],
  ['video/mp4', 'maybe'],
  ['video/mp4; codecs="avc1.42E01E,mp4a.40.2"', 'probably'],
  ['video/mp4; codecs="avc1.640029,mp4a.40.2"', 'probably'],
  ['video/mp4; codecs="avc1.6E0033"', 'probably'],          // H.264 High 10 — ENGINE LIES
  ['video/mp4; codecs="hvc1.2.4.L153.B0"', 'probably'],
  ['video/mp4; codecs="hev1.2.4.L153.B0"', 'probably'],
  ['video/mp4; codecs="hvc1.2.4.L4.B0"', 'probably'],       // level 0.13 — ENGINE LIES
  ['video/mp4; codecs="hvc1.2.4.L153.5.B0"', 'probably'],   // fractional — ENGINE LIES
  ['video/mp4; codecs="hvc1.1.6.L29.B0"', 'probably'],      // ENGINE LIES
  ['video/mp4; codecs="hvc1.2.4.L1000.B0"', ''],            // > one byte: the ONE refusal
  ['video/mp4; codecs="av01.0.05M.08"', 'probably'],
  ['video/mp4; codecs="av01.0.05M.10"', 'probably'],        // 10-bit AV1 — ENGINE LIES
  ['video/mp4; codecs="ac-3"', ''],
  ['video/mp4; codecs="ec-3"', ''],
  ['video/webm', 'maybe'],
  ['video/webm; codecs="vp9"', 'probably'],                 // short form OK in webm only
  ['video/webm; codecs="vp09.00.10.08"', 'probably'],
  ['video/quicktime', ''],
  ['video/quicktime; codecs="avc1.42E01E,mp4a.40.2"', ''],
  ['video/mp2t', ''],
  ['video/ogg', 'maybe'],
  ['video/x-total-nonsense', '']
];

const { document } = installDomShim({
  credentials: { Servers: [{ AccessToken: 'tok', UserId: 'usr', ManualAddress: 'http://localhost' }] },
  canPlayType: modelEngine
});
engine = CHROMIUM;
globalThis.window.Events = fakeEvents;

// SELF-CHECK, before any veto test runs. If the model does not reproduce the measurement,
// every 'auto' assertion below is describing an engine that does not exist.
{
  const wrong = MEASURED
    .map(([mime, expected]) => [mime, modelEngine(mime), expected])
    .filter(([, got, expected]) => got !== expected)
    .map(([mime, got, expected]) => `${mime} -> ${JSON.stringify(got)} (measured ${JSON.stringify(expected)})`);
  ok(`engine model reproduces all ${MEASURED.length} measured canPlayType rows`, wrong.length === 0, wrong);
  if (wrong.length) {
    realError('  the engine model is wrong; every veto check below would be meaningless. Stopping.');
    process.exit(1);
  }
}

function makeExoPlayerPlugin() {
  return {
    type: 'mediaplayer', id: 'exoplayervideo', priority: -1,
    play() {}, stop() {}, canPlayMediaType() { return true; }
  };
}
/**
 * One MediaSource fixture builder. `Index` is populated on every stream because
 * DefaultAudioStreamIndex is matched against it (E1).
 */
function source({ id, container = 'mp4', video = { Codec: 'h264' }, audio = { Codec: 'aac' },
  directPlay = true, defaultAudioIndex, streams, audioTracks } = {}) {
  const MediaStreams = streams !== undefined ? streams : [
    ...(video ? [{ Type: 'Video', Index: 0, ...video }] : []),
    ...(audioTracks
      ? audioTracks.map((a, i) => ({ Type: 'Audio', Index: i + 1, ...a }))
      : (audio ? [{ Type: 'Audio', Index: 1, ...audio }] : []))
  ];
  const src = { Container: container, SupportsDirectPlay: directPlay };
  if (id !== undefined) src.Id = id;
  if (defaultAudioIndex !== undefined) src.DefaultAudioStreamIndex = defaultAudioIndex;
  if (streams !== null) src.MediaStreams = MediaStreams;
  return src;
}
/** One item fixture builder, so every 'auto' case differs only in what it is testing. */
function item(Id, opts = {}) {
  return { Id, MediaSources: [source(opts)] };
}
/** A multi-version item, for playOptions.mediaSourceId (E2). */
const multiVersionItem = (Id, sources) => ({ Id, MediaSources: sources });
const directPlayItem = (Id) => item(Id);
const transcodeItem = (Id) => item(Id, { container: 'avi', video: { Codec: 'mpeg2video' } });
const noStreamsItem = (Id) => item(Id, { streams: null });

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
// §4 Veto mechanics — B6, the platform gate, 'auto' probing, the guards, F12 attribution
// ═════════════════════════════════════════════════════════════════════════════════════
globalThis.window.ExternalPlayer = { isEnabled: () => true, initPlayer: () => {} }; // native bridge
CONFIG.androidVetoExternalPlayer = true; // consider it, so B6 rejects it on SHAPE not policy
veto.scanAndVeto();
ok('F3: veto installs once the safety valve exists', veto.vetoStatus().pluginsPatched === 1);
ok('B6: the native bridge was NOT patched', globalThis.window.ExternalPlayer.canPlayItem === undefined);
ok('B6: the plugin instance WAS patched', typeof exo.canPlayItem === 'function');
ok('F1: status reports the platform it gated on', veto.vetoStatus().platformAndroid === true);

ok("veto 'always': every item is vetoed", exo.canPlayItem(transcodeItem('mkv1')) === false);
CONFIG.androidForceWebPlayer = 'auto';

// ── 'auto' probing. `canPlayItem` returns FALSE when we veto (push to the web player)
// and TRUE when we stand aside. Read `=== false` as "overlay", `=== true` as "no overlay".
const vetoed = (it, opts) => exo.canPlayItem(it, opts) === false;
const probe = () => veto.vetoStatus().lastProbe;

ok("'auto': mp4 + h264 + aac is vetoed", vetoed(item('mp4ok')));
ok("'auto': and it was asked in video/mp4",
  probe().mime === 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"', probe());

// THE v4.3.0 FIELD BUG. A normal library is mostly MKV. Chromium DOES have a
// video/x-matroska entry (measured "maybe" bare, and it answers codec-specifically), so
// the one combined probe is asked in the item's real container and answered there.
ok("'auto': mkv + h264 + aac is vetoed, asked in matroska",
  vetoed(item('mkvh264', { container: 'mkv' }))
  && probe().mime === 'video/x-matroska; codecs="avc1.42E01E,mp4a.40.2"', probe());

// FALLBACK A IS DELETED, and this pins it. On an engine that genuinely has no matroska
// entry the item must DECLINE — never get re-asked in some other container it happens to
// speak. (Restoring the fallback turns this red.)
engine = { 'video/mp4': [avc, lit('mp4a.40.2')], 'video/webm': [lit('vp8', 'vp9')] };
ok("'auto': an engine with no matroska entry declines instead of re-asking elsewhere",
  !vetoed(item('mkvnomkv', { container: 'mkv' }))
  && /does not recognise this container MIME/.test(probe().reason), probe());
engine = CHROMIUM;

// ...and a real NO from a container the engine DOES recognise is honoured.
engine = { 'video/x-matroska': [lit('mp4a.40.2')], 'video/mp4': [avc, lit('mp4a.40.2')] };
ok("'auto': a genuine codec refusal from a recognised container declines",
  !vetoed(item('mkvrefused', { container: 'mkv' })));
engine = CHROMIUM;

// ── C1 — VP9. The documented limit, pinned in both directions. ────────────────────────
ok("C1: vp9-in-mkv DECLINES by design (the short form is webm-only)",
  !vetoed(item('vp9mkv', { container: 'mkv', video: { Codec: 'vp9' }, audio: { Codec: 'opus' } })), probe());
ok("C1: vp9-in-webm is vetoed, so the limit really is container-specific",
  vetoed(item('vp9webm', { container: 'webm', video: { Codec: 'vp9' }, audio: { Codec: 'opus' } }))
  && probe().mime === 'video/webm; codecs="vp9,opus"', probe());
ok("C1: vp8-in-mkv IS vetoed — the short form is legal there, so this is codec-specific",
  vetoed(item('vp8mkv', { container: 'mkv', video: { Codec: 'vp8' }, audio: { Codec: 'opus' } })));

// ── Audio codecs decide the answer, and the engine decides the audio codecs. ──────────
engine = { ...CHROMIUM, 'video/x-matroska': [avc, hevc, av1, vp09, lit('vp8', 'mp4a.40.2', 'ac-3', 'ec-3')] };
ok("'auto': mkv + h264 + ac3 is vetoed where the engine decodes ac-3",
  vetoed(item('mkvac3', { container: 'mkv', audio: { Codec: 'ac3' } }))
  && probe().mime === 'video/x-matroska; codecs="avc1.42E01E,ac-3"', probe());
ok("'auto': mkv + h264 + eac3 is vetoed where the engine decodes ec-3",
  vetoed(item('mkveac3', { container: 'mkv', audio: { Codec: 'eac3' } }))
  && probe().mime === 'video/x-matroska; codecs="avc1.42E01E,ec-3"', probe());
engine = CHROMIUM;
ok("'auto': the same ac3 item declines on the measured engine, which has no Dolby decoder",
  !vetoed(item('mkvac3no', { container: 'mkv', audio: { Codec: 'ac3' } })));
ok("'auto': and so does the eac3 one",
  !vetoed(item('mkveac3no', { container: 'mkv', audio: { Codec: 'eac3' } })));
ok("'auto': an unmapped audio codec (dts) declines without a probe",
  !vetoed(item('mkvdts', { container: 'mkv', audio: { Codec: 'dts' } }))
  && /unmapped audio codec/.test(probe().reason));

// ── Containers and video codecs. ──────────────────────────────────────────────────────
ok("'auto': an unmapped container (avi) declines",
  !vetoed(item('avi1', { container: 'avi' }))
  && /container not in CONTAINER_MIMES/.test(probe().reason));
// CONTAINER_MIMES, pinned entry by entry. `ts` and `ogv` used to have a check each, but
// both took the identical "not in the map" branch the `avi` case above already covers,
// while the MAPPINGS themselves — the values that decide which MIME the engine is asked —
// were undefended: `mov -> video/quicktime` was a surviving mutation even though
// video/quicktime is measured '' and would decline every .mov. This asks each container
// and reads back the MIME that was actually used.
ok('CONTAINER_MIMES: every mapping is the one the engine gets asked', (() => {
  const expected = [
    ['mp4', 'video/mp4'], ['m4v', 'video/mp4'], ['mov', 'video/mp4'],
    ['webm', 'video/webm'], ['mkv', 'video/x-matroska']
  ];
  return expected.every(([container, mime]) => {
    const opts = container === 'webm'
      ? { container, video: { Codec: 'vp8' }, audio: { Codec: 'opus' } }
      : { container };
    if (!vetoed(item(`map_${container}`, opts))) return false;
    return probe().mime.startsWith(`${mime}; codecs=`);
  });
})(), probe());
ok("'auto': a container that is NOT in the map declines (ts, ogv — both dropped on purpose)",
  !vetoed(item('ts1', { container: 'ts' })) && !vetoed(item('ogv1', { container: 'ogv' }))
  && /container not in CONTAINER_MIMES/.test(probe().reason), probe());
ok("'auto': an unmapped video codec (mpeg2video) declines",
  !vetoed(item('mpeg2', { video: { Codec: 'mpeg2video' } }))
  && /unmapped video codec/.test(probe().reason));
ok("'auto': a video-only source is legitimate and is vetoed",
  vetoed(item('silent', { container: 'mkv', audio: null })));

// ── HEVC. The id is DERIVED, and every part of the derivation is tested SEPARATELY. ───
//
// The single 'hevcbare' fixture used to omit BOTH Profile and Level, so the two guards
// masked each other: either could be deleted with no red check. These four separate the
// concerns, and the range block below covers the level values the engine lies about.
engine = { ...CHROMIUM, 'video/x-matroska': [hevc, lit('mp4a.40.2')] };
ok("'auto': HEVC Main10/L5.1 builds the matching id and is vetoed",
  vetoed(item('hevc10', { container: 'mkv', video: { Codec: 'hevc', Profile: 'Main 10', Level: 153 } }))
  && probe().mime === 'video/x-matroska; codecs="hvc1.2.4.L153.B0,mp4a.40.2"', probe());
ok("'auto': HEVC Main/L3.1 builds the Main id",
  vetoed(item('hevc8', { container: 'mkv', video: { Codec: 'hevc', Profile: 'Main', Level: 93 } }))
  && probe().mime === 'video/x-matroska; codecs="hvc1.1.6.L93.B0,mp4a.40.2"', probe());
ok("'auto': h265 is accepted as a spelling of hevc",
  vetoed(item('h265', { container: 'mkv', video: { Codec: 'h265', Profile: 'Main', Level: 93 } })));
ok("'auto': HEVC with NEITHER Profile nor Level declines",
  !vetoed(item('hevcbare', { container: 'mkv', video: { Codec: 'hevc' } })));
ok("'auto': HEVC with a Profile but NO Level declines (level guard, in isolation)",
  !vetoed(item('hevcnolevel', { container: 'mkv', video: { Codec: 'hevc', Profile: 'Main 10' } })));
ok("'auto': HEVC with a Level but NO Profile declines (profile guard, in isolation)",
  !vetoed(item('hevcnoprofile', { container: 'mkv', video: { Codec: 'hevc', Level: 153 } })));
ok("'auto': an unrecognised HEVC Profile (Rext) declines even with a valid Level",
  !vetoed(item('hevcrext', { container: 'mkv', video: { Codec: 'hevc', Profile: 'Rext', Level: 153 } })));
// An HEVC decline must NOT read `unmapped video codec "hevc"`. That was untrue — hevc is
// mapped, in hevcCodecId() — and it sent a field reporter to VIDEO_CODEC_IDS, where a
// comment tells them HEVC is not in that table. HEVC is plausibly the highest-volume codec
// in a real library, so the two derivation failures are named separately.
ok('lastProbe: an HEVC LEVEL failure names the level, not the codec map',
  !vetoed(item('hevclvlreason', { container: 'mkv', video: { Codec: 'hevc', Profile: 'Main 10', Level: 4 } }))
  && /HEVC Level/.test(probe().reason)
  && !/unmapped video codec/.test(probe().reason), probe());
ok('lastProbe: an HEVC PROFILE failure names the profile, not the codec map',
  !vetoed(item('hevcprofreason', { container: 'mkv', video: { Codec: 'hevc', Profile: 'Rext', Level: 153 } }))
  && /unrecognised HEVC Profile/.test(probe().reason)
  && !/unmapped video codec/.test(probe().reason), probe());
ok('lastProbe: a genuinely unmapped codec still says so',
  !vetoed(item('trulyunmapped', { container: 'mkv', video: { Codec: 'mpeg2video' } }))
  && /unmapped video codec/.test(probe().reason), probe());

// A2 — THE LEVEL RANGE. Each of these returns "probably" from the real engine (measured),
// so every one of them is a wrong-yes the engine will happily hand us. general_level_idc
// is level x 30, so a plausible-looking 4.0 means level 0.13.
for (const [label, Level] of [
  ['4 (a human level reported instead of general_level_idc)', 4],
  ['4.0 (same, as a float)', 4.0],
  ['29 (just under L1.0)', 29],
  ['153.5 (fractional — not a level_idc at all)', 153.5],
  ['1000 (wider than the one byte general_level_idc gets)', 1000]
]) {
  // "…without asking the engine" is the load-bearing half for L1000: the engine refuses
  // that one on its own (a level wider than a byte), so a check that only asserted the
  // OUTCOME would pass with the upper bound deleted. The guard has to be observed by the
  // absence of a probe — `mime` is only recorded when canPlayType was actually consulted.
  ok(`A2: HEVC Level ${label} declines, without asking the engine`,
    !vetoed(item(`hevclvl${Level}`, { container: 'mkv', video: { Codec: 'hevc', Profile: 'Main 10', Level } }))
    && probe().mime === undefined
    && /not a general_level_idc/.test(probe().reason),
    probe());
}
ok('A2: the boundary levels are ACCEPTED — L1.0 (30) and the byte maximum (255)',
  vetoed(item('hevcl30', { container: 'mkv', video: { Codec: 'hevc', Profile: 'Main', Level: 30 } }))
  && vetoed(item('hevcl255', { container: 'mkv', video: { Codec: 'hevc', Profile: 'Main', Level: 255 } })));
ok('A2: every real general_level_idc value is accepted', (() => {
  const real = [30, 60, 63, 90, 93, 120, 123, 150, 153, 156, 180, 183, 186];
  return real.every(Level =>
    vetoed(item(`real${Level}`, { container: 'mkv', video: { Codec: 'hevc', Profile: 'Main', Level } })));
})());
engine = CHROMIUM;

// ── A1 / A3 — THE 10-BIT GUARD. The engine says "probably" to every one of these. ─────
ok('A1: Hi10P H.264 (BitDepth 10) declines — Chromium cannot decode it',
  !vetoed(item('hi10depth', { container: 'mkv', video: { Codec: 'h264', BitDepth: 10 } }))
  && /10-bit video/.test(probe().reason), probe());
ok('A1: Hi10P H.264 declines on Profile "High 10" alone, with no BitDepth',
  !vetoed(item('hi10prof', { container: 'mkv', video: { Codec: 'h264', Profile: 'High 10' } })), probe());
ok('A1: ordinary 8-bit H.264 with an explicit BitDepth is unaffected',
  vetoed(item('h264depth8', { container: 'mkv', video: { Codec: 'h264', BitDepth: 8, Profile: 'High' } })));
ok('A3: 10-bit AV1 declines — av01.0.05M.08 asserts 8 bits',
  !vetoed(item('av1ten', { container: 'mkv', video: { Codec: 'av1', BitDepth: 10 } }))
  && /10-bit video/.test(probe().reason), probe());
ok('A3: 8-bit AV1 is still vetoed',
  vetoed(item('av1eight', { container: 'mkv', video: { Codec: 'av1', BitDepth: 8 } })));
ok('A1: 12-bit video declines too (the guard is > 8, not === 10)',
  !vetoed(item('twelvebit', { container: 'mkv', video: { Codec: 'h264', BitDepth: 12 } })));
engine = { ...CHROMIUM, 'video/x-matroska': [hevc, lit('mp4a.40.2')] };
ok('A1: HEVC Main 10 at BitDepth 10 is STILL VETOED — its id describes 10 bits faithfully',
  vetoed(item('hevcmain10', {
    container: 'mkv', video: { Codec: 'hevc', Profile: 'Main 10', Level: 153, BitDepth: 10 }
  }))
  && probe().mime === 'video/x-matroska; codecs="hvc1.2.4.L153.B0,mp4a.40.2"', probe());
ok('A1: HEVC MAIN (8-bit id) at BitDepth 10 declines — that id would be a lie',
  !vetoed(item('hevcmain8at10', {
    container: 'mkv', video: { Codec: 'hevc', Profile: 'Main', Level: 153, BitDepth: 10 }
  })), probe());
// THE 4.3.1 WRONG-YES. The old guard exempted on the codec id's FAMILY — "is this a
// >=10-bit id?" — so `hvc1.2.4.…` waved through any depth above 8. The engine answers
// "probably" to hvc1.2.4.L153.B0 because Main 10 is a family it decodes, and the WebView
// was then handed a 12-bit stream. Main 10 means TEN bits, not "ten or more".
ok('A1: HEVC Main 10 at BitDepth 12 DECLINES — hvc1.2.4 claims ten bits, not twelve',
  !vetoed(item('hevcmain10at12', {
    container: 'mkv', video: { Codec: 'hevc', Profile: 'Main 10', Level: 153, BitDepth: 12 }
  }))
  && /12-bit video/.test(probe().reason), probe());
ok('A1: and at BitDepth 16 too — the guard is a comparison, not a special case for 12',
  !vetoed(item('hevcmain10at16', {
    container: 'mkv', video: { Codec: 'hevc', Profile: 'Main 10', Level: 153, BitDepth: 16 }
  })), probe());
ok('A1: HEVC Main 10 at BitDepth 8 is still vetoed — the id over-describes, which is safe',
  vetoed(item('hevcmain10at8', {
    container: 'mkv', video: { Codec: 'hevc', Profile: 'Main 10', Level: 153, BitDepth: 8 }
  })), probe());
// Contradictory metadata resolves AGAINST the engine: the deepest signal available wins.
ok('A1: Profile "High 10" with a contradicting BitDepth 8 still declines',
  !vetoed(item('hi10contra', {
    container: 'mkv', video: { Codec: 'h264', Profile: 'High 10', BitDepth: 8 }
  })), probe());
engine = CHROMIUM;

// ── THE `main 10` ARM OF TEN_BIT_PROFILE_RE, restored after being deleted as "dead". ──
//
// It IS dead for HEVC — hevcCodecId() already turns Profile "Main 10" into an id that
// claims ten bits, and an 18,900-item differential found zero behavioural differences for
// hevc/h265 with the arm removed. But the predicate runs against `stream.Profile` for ANY
// codec, and every other mapped codec emits an 8-bit id. Measured on the shipped code with
// the arm removed: av1 + "Main 10" was VETOED as av01.0.05M.08, h264 + "Main 10" as
// avc1.42E01E, vp8 + "Main 10" as vp8 — three wrong-yes paths bought for nothing.
for (const [codec, opts] of [
  ['h264', { Codec: 'h264', Profile: 'Main 10' }],
  ['av1', { Codec: 'av1', Profile: 'Main 10' }],
  ['vp8', { Codec: 'vp8', Profile: 'Main 10' }]
]) {
  ok(`A1: ${codec} + Profile "Main 10" declines — its id says 8 bits and the name says 10`,
    !vetoed(item(`main10_${codec}`, { container: 'mkv', video: opts }))
    && /10-bit video/.test(probe().reason), probe());
}
// ...and the arm is still inert where it was proven inert: HEVC Main 10 keeps its 10-bit id
// and is still vetoed, so restoring the arm cost nothing on the codec it was deleted over.
engine = { ...CHROMIUM, 'video/x-matroska': [hevc, lit('mp4a.40.2')] };
ok('A1: restoring the arm does NOT regress HEVC Main 10 — hvc1.2.4 already claims ten bits',
  vetoed(item('main10hevcstill', {
    container: 'mkv', video: { Codec: 'hevc', Profile: 'Main 10', Level: 153 }
  }))
  && probe().mime === 'video/x-matroska; codecs="hvc1.2.4.L153.B0,mp4a.40.2"', probe());
engine = CHROMIUM;

// ── NON-4:2:0 H.264 PROFILES. A DEPTH GUARD CANNOT SEE THESE. ─────────────────────────
//
// h264/avc/avc1 map unconditionally to `avc1.42E01E`, which is Baseline — 8-bit 4:2:0. A
// High 4:2:2 stream at 8 bits has nothing wrong with its DEPTH, so tenBitMismatch() passes
// it, the engine answers "probably" about the H.264 family (THE GOVERNING INSIGHT), and the
// WebView is handed a file nobody asked it about. Measured on the shipped code before
// chromaMismatch() existed: all five of these were VETOED with the 8-bit 4:2:0 id.
for (const Profile of ['High 4:2:2', 'High 4:2:2 Intra', 'High 4:4:4 Predictive',
                       'High 4:4:4 Intra', 'CAVLC 4:4:4']) {
  ok(`A4: h264 + Profile "${Profile}" declines — avc1.42E01E describes 4:2:0`,
    !vetoed(item(`chroma_${Profile.replace(/\W/g, '')}`, {
      container: 'mkv', video: { Codec: 'h264', Profile }
    }))
    && /is not 4:2:0 video/.test(probe().reason), probe());
}
// The negative half, and it is the one that matters: ordinary High is 4:2:0 and universally
// decodable. A guard that declined it would cost the overlay on most of a real library.
ok('A4: ordinary H.264 High / Main / Baseline are untouched by the chroma guard', (() => {
  return ['High', 'Main', 'Baseline', 'Constrained Baseline'].every(Profile =>
    vetoed(item(`chromaok_${Profile.replace(/\W/g, '')}`, {
      container: 'mkv', video: { Codec: 'h264', Profile }
    })));
})(), probe());
// It is a chroma check, not a depth one: a 4:2:2 stream that also reports 8 bits still
// declines, so the two guards are independent rather than one standing in for the other.
ok('A4: High 4:2:2 with an explicit BitDepth 8 still declines — depth is not the signal',
  !vetoed(item('chroma422at8', {
    container: 'mkv', video: { Codec: 'h264', Profile: 'High 4:2:2', BitDepth: 8 }
  }))
  && /is not 4:2:0 video/.test(probe().reason), probe());

// ── E1 / E2 — probe the stream and the source that will ACTUALLY be played. ───────────
engine = { ...CHROMIUM, 'video/x-matroska': [avc, lit('mp4a.40.2', 'ac-3')] };
ok('E1: a dual-audio item honours DefaultAudioStreamIndex, not the first audio track',
  vetoed(item('dual', {
    container: 'mkv', defaultAudioIndex: 2,
    audioTracks: [{ Codec: 'aac' }, { Codec: 'ac3' }]
  }))
  && probe().mime === 'video/x-matroska; codecs="avc1.42E01E,ac-3"', probe());
engine = CHROMIUM;
ok('E1: and the choice is load-bearing — the same item declines when ac-3 is undecodable',
  !vetoed(item('dual2', {
    container: 'mkv', defaultAudioIndex: 2,
    audioTracks: [{ Codec: 'aac' }, { Codec: 'ac3' }]
  })), probe());
ok('E1: an out-of-range DefaultAudioStreamIndex falls back to the first audio track',
  vetoed(item('dual3', {
    container: 'mkv', defaultAudioIndex: 99,
    audioTracks: [{ Codec: 'aac' }, { Codec: 'dts' }]
  })), probe());
ok('E1: DefaultAudioStreamIndex pointing at the VIDEO stream falls back too, never probes video as audio',
  vetoed(item('dual4', {
    container: 'mkv', defaultAudioIndex: 0,
    audioTracks: [{ Codec: 'aac' }, { Codec: 'dts' }]
  })), probe());

// ── E1, the two arms the first cut did not have. ──────────────────────────────────────
//
// getPlayer() is handed playOptions, and when the user picks the AC3 track on a dual-audio
// item, THAT is where the choice lives — DefaultAudioStreamIndex still points at the AAC
// default. Probing the default and answering about a codec nobody selected is a wrong yes.
// (We could not confirm from jellyfin-web's source that this field is forwarded on every
// path, so the code uses it defensively: honoured when present, ignored when absent. These
// two checks pin both halves of that.)
engine = { ...CHROMIUM, 'video/x-matroska': [avc, lit('mp4a.40.2')] };
ok('E1: playOptions.audioStreamIndex beats DefaultAudioStreamIndex — the user chose it',
  !vetoed(item('userpick', {
    container: 'mkv', defaultAudioIndex: 1,
    audioTracks: [{ Codec: 'aac' }, { Codec: 'ac3' }]
  }), { audioStreamIndex: 2 })
  && /unmapped audio codec/.test(probe().reason) === false
  && probe().decision === 'declined', probe());
ok('E1: and the same item WITHOUT playOptions probes the aac default instead',
  vetoed(item('userpick2', {
    container: 'mkv', defaultAudioIndex: 1,
    audioTracks: [{ Codec: 'aac' }, { Codec: 'ac3' }]
  }))
  && probe().mime === 'video/x-matroska; codecs="avc1.42E01E,mp4a.40.2"', probe());
ok('E1: an out-of-range playOptions.audioStreamIndex falls through to the default',
  vetoed(item('userpick3', {
    container: 'mkv', defaultAudioIndex: 1,
    audioTracks: [{ Codec: 'aac' }, { Codec: 'ac3' }]
  }), { audioStreamIndex: 99 }), probe());
// Jellyfin's own fallback when no index is given at all is the stream flagged IsDefault,
// not the first audio track in array order.
ok('E1: with no index anywhere, the IsDefault audio stream wins over the first one',
  vetoed({
    Id: 'flagdefault',
    MediaSources: [{
      Container: 'mkv', SupportsDirectPlay: true,
      MediaStreams: [
        { Type: 'Video', Index: 0, Codec: 'h264' },
        { Type: 'Audio', Index: 1, Codec: 'dts' },
        { Type: 'Audio', Index: 2, Codec: 'aac', IsDefault: true }
      ]
    }]
  }) && probe().mime === 'video/x-matroska; codecs="avc1.42E01E,mp4a.40.2"', probe());
// The `>= 0` arm of the index bound. Index 0 is a legal audio index whenever the video
// stream is not first, and `> 0` would silently skip it — observable only when array order
// and index order disagree, which is exactly the shape E1/E2 exist for.
ok('E1: DefaultAudioStreamIndex 0 is honoured when index 0 really is an audio stream',
  vetoed({
    Id: 'audioatzero',
    MediaSources: [{
      Container: 'mkv', SupportsDirectPlay: true, DefaultAudioStreamIndex: 0,
      MediaStreams: [
        { Type: 'Audio', Index: 2, Codec: 'dts' },
        { Type: 'Video', Index: 1, Codec: 'h264' },
        { Type: 'Audio', Index: 0, Codec: 'aac' }
      ]
    }]
  }) && probe().mime === 'video/x-matroska; codecs="avc1.42E01E,mp4a.40.2"', probe());
// ...and the OTHER half of that bound, `Number.isInteger`. A fractional index is not an
// index; the record is malformed and the right response is to fall back, not to honour it.
// Observable only when the fractional index actually matches a stream, which is what this
// (deliberately hostile) fixture arranges — index 1.5 points at the undecodable track.
ok('E1: a fractional DefaultAudioStreamIndex is not an index — fall back, do not honour it',
  vetoed({
    Id: 'fractionalindex',
    MediaSources: [{
      Container: 'mkv', SupportsDirectPlay: true, DefaultAudioStreamIndex: 1.5,
      MediaStreams: [
        { Type: 'Video', Index: 0, Codec: 'h264' },
        { Type: 'Audio', Index: 1, Codec: 'aac' },
        { Type: 'Audio', Index: 1.5, Codec: 'dts' }
      ]
    }]
  }) && probe().mime === 'video/x-matroska; codecs="avc1.42E01E,mp4a.40.2"', probe());
// The video stream is chosen BY TYPE, not by position. Every other fixture in this file
// puts video at MediaStreams[0], so `find(Type === 'Video')` and `streams[0]` were
// indistinguishable — and E1/E2 both exist because a positional assumption was wrong.
ok('E1: the video stream is found by Type even when it is not first in MediaStreams',
  vetoed({
    Id: 'videonotfirst',
    MediaSources: [{
      Container: 'mkv', SupportsDirectPlay: true,
      MediaStreams: [
        { Type: 'Audio', Index: 1, Codec: 'aac' },
        { Type: 'Video', Index: 0, Codec: 'h264' }
      ]
    }]
  }) && probe().mime === 'video/x-matroska; codecs="avc1.42E01E,mp4a.40.2"', probe());
engine = CHROMIUM;

const twoVersions = multiVersionItem('multi', [
  source({ id: 'v1080', container: 'mkv', video: { Codec: 'h264' }, audio: { Codec: 'aac' } }),
  source({ id: 'v4k', container: 'mkv', video: { Codec: 'mpeg2video' }, audio: { Codec: 'aac' } })
]);
ok('E2: with no playOptions the first MediaSource is probed, as before',
  vetoed(twoVersions) && probe().mime === 'video/x-matroska; codecs="avc1.42E01E,mp4a.40.2"', probe());
ok('E2: playOptions.mediaSourceId selects the version the user actually chose',
  !vetoed(twoVersions, { mediaSourceId: 'v4k' })
  && /unmapped video codec "mpeg2video"/.test(probe().reason), probe());
// A wrong yes breaks playback; a decline only costs the overlay. "The caller named a
// source I cannot find" means the record we would probe is not the record that will be
// played — the same reasoning as FALLBACK B, which this file already applies forty lines
// away. Falling back to MediaSources[0] here probed a DIFFERENT file and, on this fixture,
// vetoed on the strength of it.
ok('E2: a mediaSourceId that matches nothing DECLINES — it does not probe another source',
  !vetoed(twoVersions, { mediaSourceId: 'nosuchsource' })
  && /matches no MediaSource/.test(probe().reason), probe());
ok('E2: an empty mediaSourceId is "not supplied", not "no match" — first source, as before',
  vetoed(twoVersions, { mediaSourceId: '' }), probe());

// ── Fail-closed basics. ───────────────────────────────────────────────────────────────
ok('F12: an item with no MediaStreams fails closed (not vetoed)', !vetoed(noStreamsItem('bare')));
ok("'auto': an item with no MediaSources at all declines",
  !vetoed({ Id: 'nosources' }) && /no MediaSources/.test(probe().reason));
ok("'auto': SupportsDirectPlay false declines even for a playable codec set",
  !vetoed(item('nodp', { directPlay: false }))
  && /neither DirectPlay nor DirectStream/.test(probe().reason));
ok("'auto': SupportsDirectStream alone is enough", (() => {
  const it = item('dsonly', { directPlay: false });
  it.MediaSources[0].SupportsDirectStream = true;
  return vetoed(it);
})());

exo.canPlayItem(directPlayItem('itemA'));
fakeEvents.trigger(playbackManager, 'playbackerror', ['MediaDecodeError']);
ok('§3: a failed vetoed item is suspended', veto.vetoStatus().suspendedItems === 1);
ok('§3: the suspended item now falls back to the native player',
  exo.canPlayItem(directPlayItem('itemA')) === true);
ok('§3: and lastProbe says WHY, instead of leaving the last real probe standing',
  probe() !== null && /suspended after a playback failure/.test(probe().reason), probe());

// F12 ATTRIBUTION, and why this needs a THIRD item.
//
// The check used to be "burn itemA, then decide about itemB, then fail — count is still 1".
// Reverting F12 (record lastDecision only for VETOES) survived that: the stale lastDecision
// still pointed at itemA, the failure re-suspended an item that was already suspended, and
// the count never moved. So the pair of checks read as covered while being half-covered.
// itemC is vetoed and fresh, so under the reverted code the failure below lands on IT and
// the count goes to 2. lastDecision.id is asserted as well, which kills it directly.
exo.canPlayItem(directPlayItem('itemC'));                    // vetoed, and NOT yet suspended
exo.canPlayItem(transcodeItem('itemB'));                     // declined — not our doing
fakeEvents.trigger(playbackManager, 'playbackerror', ['MediaDecodeError']);
ok('F12: a failure after a non-veto decision suspends nothing',
  veto.vetoStatus().suspendedItems === 1, veto.vetoStatus().suspendedItems);
ok('F12: the recorded decision is the one that was actually last, veto or not',
  veto.vetoStatus().lastDecision.id === 'itemB'
  && veto.vetoStatus().lastDecision.vetoed === false, veto.vetoStatus().lastDecision);
ok('F12: and the previously vetoed item was not collaterally suspended',
  exo.canPlayItem(directPlayItem('itemC')) === false);

// ═════════════════════════════════════════════════════════════════════════════════════
// §4b The persisted suspension store — D1 FIFO, D2 TTL, D3 size bail, D4 status
// ═════════════════════════════════════════════════════════════════════════════════════
// PERSISTED SUSPENSIONS. A session-scoped Set turned "this item breaks once" into "this
// item breaks once per app launch, forever" — likely, not theoretical, once the probe
// started asking an optimistic engine. But permanent persistence is worse in the other
// direction: `playbackerror` also fires for network faults, so a Wi-Fi blip blacklisted an
// item for good. Hence persistence WITH a TTL, and both bounds are tested.
ok('suspensions are written to localStorage', veto.vetoStatus().suspensionsPersisted === true);
const persistedRaw = globalThis.localStorage.getItem('jfPauseScreenVetoSuspended');
ok('the store holds the burned item id', /itemA/.test(persistedRaw || ''), persistedRaw);
ok('the store is [id, timestamp] pairs, not bare ids (a bare id could never age out)', (() => {
  const parsed = JSON.parse(persistedRaw);
  const first = parsed && Array.isArray(parsed.s) ? parsed.s[0] : null;
  return Array.isArray(first) && first.length === 2
    && typeof first[0] === 'string' && typeof first[1] === 'number';
})(), persistedRaw);
// The build stamp. Without it, a suspension recorded by 4.3.1 is honoured verbatim by
// 4.3.2 for up to another seven days — including suspensions of the very items 4.3.2 fixed.
// The header's "a fix shipped today cannot be masked by a suspension recorded against
// yesterday's build" was a claim, not an implementation, until this field existed.
ok('the store carries the build that wrote it', (() => {
  const parsed = JSON.parse(persistedRaw);
  return parsed && parsed.v === CONFIG.version;
})(), persistedRaw);
ok('status reports the TTL it is enforcing', veto.vetoStatus().suspensionTtlDays === 7,
  veto.vetoStatus().suspensionTtlDays);

/** The on-disk shape, in one place, so a format change breaks compile-time not silently. */
const packStore = (pairs, v = CONFIG.version) => JSON.stringify({ v, s: pairs });

/** A private localStorage per store test, so they cannot contaminate each other. */
function withStore(initial) {
  const map = new Map();
  if (initial !== undefined) map.set('jfPauseScreenVetoSuspended', initial);
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v)
  };
}
/** Boot a fresh module instance (fresh in-memory state) against a given store. */
let freshCount = 0;
async function freshVeto(store) {
  const saved = globalThis.localStorage;
  if (store) globalThis.localStorage = store;
  const mod = await import(`../src/services/players/androidVeto.js?fresh${freshCount++}`);
  const plugin = makeExoPlayerPlugin();
  globalThis.window.ExoPlayerPlugin = plugin;
  mod.scanAndVeto();
  return {
    mod,
    plugin,
    restore() { delete globalThis.window.ExoPlayerPlugin; globalThis.localStorage = saved; }
  };
}

{
  // A fresh module instance is a fresh session: same localStorage, empty in-memory Map.
  const s = await freshVeto(null);
  ok('reload: the fresh instance patched its own plugin', typeof s.plugin.canPlayItem === 'function');
  ok('reload: a previously burned item is STILL suspended across sessions',
    s.plugin.canPlayItem(directPlayItem('itemA')) === true);
  ok('reload: an unrelated item is unaffected', s.plugin.canPlayItem(item('freshone')) === false);
  ok('reload: the loaded suspension is counted', s.mod.vetoStatus().suspendedItems >= 1);
  s.restore();
}
{
  // D4 — vetoStatus() must be correct BEFORE any player decision, and on a HEALTHY EMPTY
  // store. Both reviewers flagged this: the count read 0 until the first decision, and a
  // fresh install reported suspensionsPersisted:false, which the field's own docstring
  // says means private mode or a hardened WebView.
  const s = await freshVeto(withStore());
  const status = s.mod.vetoStatus();   // NOTHING has called canPlayItem yet
  ok('D4: a healthy EMPTY store reports suspensionsPersisted:true', status.suspensionsPersisted === true);
  ok('D4: and reports 0 suspensions, not undefined', status.suspendedItems === 0, status.suspendedItems);
  s.restore();
}
{
  // D4, the other half: the count must be right before the first decision too.
  const now = Date.now();
  const s = await freshVeto(withStore(packStore([['aa11', now], ['bb22', now]])));
  ok('D4: vetoStatus() loads the store rather than reporting 0 until the first decision',
    s.mod.vetoStatus().suspendedItems === 2, s.mod.vetoStatus().suspendedItems);
  s.restore();
}
{
  // D2 — TTL. An entry older than seven days is dropped on load; a fresh one survives.
  //
  // THE BOUNDARY IS EXACT. The `edge` fixture used to sit 60 s inside the window, so `<=`
  // and `<` were indistinguishable and the inclusive bound was unpinned. Date.now() is
  // frozen for the block so `now - TTL` really is the boundary at read time as well as at
  // load time — otherwise the milliseconds that elapse between the two decide the answer.
  const day = 86400000;
  const TTL = 7 * day;
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  const s = await freshVeto(withStore(packStore([
    ['stale', frozen - 8 * day],
    ['fresh', frozen - 1 * day],
    ['edge', frozen - TTL]            // EXACTLY on the boundary: age === TTL
  ])));
  ok('D2: an entry older than the 7-day TTL is dropped on load',
    s.plugin.canPlayItem(item('stale')) === false);
  ok('D2: an entry inside the TTL survives the load',
    s.plugin.canPlayItem(item('fresh')) === true);
  ok('D2: an entry exactly ON the boundary survives — the bound is inclusive',
    s.plugin.canPlayItem(item('edge')) === true);
  ok('D2: one millisecond past it does not', (() => {
    Date.now = () => frozen + 1;
    const gone = s.plugin.canPlayItem(item('edge')) === false;
    Date.now = () => frozen;
    return gone;
  })());
  ok('D2: and the expired entry is not counted', s.mod.vetoStatus().suspendedItems === 2,
    s.mod.vetoStatus().suspendedItems);
  Date.now = realNow;
  s.restore();
}
{
  // ── THE 4.3.1 BLOCKER: A FUTURE-DATED SUSPENSION NEVER EXPIRED. ─────────────────────
  //
  // `age <= TTL` is satisfied forever by an `at` in the future, and the load filter's
  // `at > cutoff` admitted one, so a single entry written while the device clock was wrong
  // became a permanent blacklist surviving every restart — precisely the failure the TTL
  // was introduced to end, and a way for a tampered store to mint one past the id-length
  // and size bounds. The real trigger is mundane: an Android device with a dead RTC boots
  // to a future clock, a network blip fires playbackerror, NTP then corrects the clock.
  const year = 365 * 86400000;
  const now = Date.now();
  const s = await freshVeto(withStore(packStore([
    ['fromthefuture', now + 10 * year],
    ['ordinary', now - 60000]
  ])));
  // TWO CHECKS USED TO LIVE HERE, LABELLED "refused at LOAD", AND THEY WERE NOT. Both
  // observed through canPlayItem / suspendedItems, i.e. through the READ-side predicate,
  // and both passed verbatim with the load-side guard deleted — duplicates of the
  // clockslip block below wearing a load-side label. They are gone; the load path gets a
  // check that only the load path can pass, two blocks down.
  //
  // What is genuinely pinned by THIS fixture is that one hostile entry does not take its
  // neighbours with it: the load loop must `continue`, not `return`, and the future entry
  // is deliberately FIRST in the list so that a `return` loses the good one.
  ok('load: a hostile entry does not discard the well-formed entry behind it in the list',
    s.plugin.canPlayItem(item('ordinary')) === true
    && s.mod.vetoStatus().suspendedItems === 1, s.mod.vetoStatus().suspendedItems);
  s.restore();
}
{
  // ── THE LOAD-SIDE GUARD, ON THE PATH ONLY IT CAN DEFEND. ────────────────────────────
  //
  // suspensionIsLive() is a WINDOW, not a half-line, so it is NOT monotone in `now`: an
  // entry dated in the future is dead now and comes ALIVE later, with no clock change and
  // no new suspension, purely because the stored `at` moves into the past. The read-side
  // check cannot stop that — by then the entry genuinely IS live. Only refusing it at LOAD
  // keeps it dead for the session.
  //
  // The mutation this exists for: `!suspensionIsLive(at, now)` -> `!(now - at <= TTL)` in
  // ensureSuspendedLoaded(). That admits a future entry to the Map, where the read side
  // hides it for exactly as long as the clock takes to catch up. It survived all 256
  // checks. So does deleting the liveness call from the load filter entirely.
  const realNow = Date.now;
  const T0 = realNow();
  Date.now = () => T0;
  const s = await freshVeto(withStore(packStore([['soon', T0 + 30 * 60000]])));
  ok('load: an entry dated 30 minutes ahead is refused at load',
    s.plugin.canPlayItem(item('soon')) === false);
  Date.now = () => T0 + 35 * 60000;      // 35 min of uptime — the stored `at` is now PAST
  ok('load: and it stays dead once the clock passes it, which the READ side cannot enforce',
    s.plugin.canPlayItem(item('soon')) === false);
  ok('load: nor does it appear in the count at that point',
    s.mod.vetoStatus().suspendedItems === 0, s.mod.vetoStatus().suspendedItems);
  Date.now = realNow;
  s.restore();
}
{
  // The same guard on the READ side, which is a different code path: this entry is written
  // by a healthy clock and the clock then moves BACKWARDS under it (an NTP correction).
  const realNow = Date.now;
  const store = withStore();
  const s = await freshVeto(store);
  s.plugin.canPlayItem(item('clockslip'));
  fakeEvents.trigger(playbackManager, 'playbackerror', ['MediaDecodeError']);
  ok('TTL: the freshly burned item is suspended while the clock is sane',
    s.plugin.canPlayItem(item('clockslip')) === true);
  Date.now = () => realNow() - 3600000;   // NTP corrects the clock an hour backwards
  ok('TTL: a suspension that is now in the FUTURE is not honoured on read',
    s.plugin.canPlayItem(item('clockslip')) === false);
  ok('TTL: nor counted', s.mod.vetoStatus().suspendedItems === 0,
    s.mod.vetoStatus().suspendedItems);
  Date.now = realNow;
  s.restore();
}
{
  // The build stamp, read side: a store written by another build is dropped WHOLE.
  const now = Date.now();
  const s = await freshVeto(withStore(packStore([['fromoldbuild', now]], '4.3.0')));
  ok('build stamp: a store written by a different version is not honoured',
    s.plugin.canPlayItem(item('fromoldbuild')) === false);
  ok('build stamp: and nothing from it is counted', s.mod.vetoStatus().suspendedItems === 0);
  ok('build stamp: persistence is still reported available — the read worked',
    s.mod.vetoStatus().suspensionsPersisted === true);
  s.restore();
}
{
  // D2 — the LOAD-TIME sweep, which is a different guarantee from the read-time TTL check.
  // Without it an expired entry stays in the Map, occupies one of the 100 cap slots and is
  // rewritten to the store on every subsequent suspension — permanent dead weight that no
  // read ever clears, because a read that returns false does not evict.
  const day = 86400000;
  const now = Date.now();
  const store = withStore(packStore([['staleone', now - 8 * day], ['keepone', now - day]]));
  const s = await freshVeto(store);
  s.plugin.canPlayItem(item('burnme'));
  fakeEvents.trigger(playbackManager, 'playbackerror', ['MediaDecodeError']);
  const written = String(store.map.get('jfPauseScreenVetoSuspended'));
  ok('D2: an expired entry is swept at load and not carried forward into the store',
    !/staleone/.test(written) && /keepone/.test(written) && /burnme/.test(written), written);
  s.restore();
}
{
  // D2 — a bare-string entry (the pre-review 4.3.1 format) carries no timestamp, so it can
  // never age out. Admitting it as "fresh" would make it permanent, which is the exact
  // behaviour the TTL exists to end.
  const s = await freshVeto(withStore(packStore(['untimestamped'])));
  ok('D2: a legacy bare-id entry is dropped rather than admitted as permanent',
    s.plugin.canPlayItem(item('untimestamped')) === false);
  s.restore();
}
{
  // D1 — RE-SUSPENSION MUST MOVE THE ITEM TO THE TAIL. Map.set() on an existing key does
  // NOT reorder it, so without an explicit delete-then-add, an item that has failed twice
  // keeps its ORIGINAL position and is evicted ahead of items that failed once, recently.
  // Reaching a re-suspension needs the first one to have expired (a live suspension is
  // never vetoed, so it can never fail again), which is what the clock stub is for.
  const day = 86400000;
  const realNow = Date.now;
  const store = withStore();
  const s = await freshVeto(store);
  const burn = (id) => {
    s.plugin.canPlayItem(item(id));
    fakeEvents.trigger(playbackManager, 'playbackerror', ['MediaDecodeError']);
  };
  burn('repeat');                                     // t0: first failure
  Date.now = () => realNow() + 8 * day;               // ...eight days pass; 'repeat' expires
  for (let i = 0; i < 99; i++) burn(`filler${i}`);    // 99 recent single-failure items
  // 'repeat' is now in the Map but expired. The Map holds 100 entries; only 99 are live,
  // and status must say 99 — an expired entry is not a suspension.
  ok('D2: the reported count excludes entries that have aged out in-session',
    s.mod.vetoStatus().suspendedItems === 99, s.mod.vetoStatus().suspendedItems);
  burn('repeat');                                     // SECOND failure — must move to tail
  ok('D1: a re-suspension does not grow the store past the cap',
    s.mod.vetoStatus().suspendedItems === 100, s.mod.vetoStatus().suspendedItems);
  burn('overflow');                                   // 101 -> evict the genuine head
  ok('D1: the cap holds at SUSPEND_MAX', s.mod.vetoStatus().suspendedItems === 100,
    s.mod.vetoStatus().suspendedItems);
  ok('D1: the OLDEST single-failure item was the one evicted',
    s.plugin.canPlayItem(item('filler0')) === false);
  ok('D1: and the re-suspended item SURVIVED newer single-failure items',
    s.plugin.canPlayItem(item('repeat')) === true);
  ok('D1: the newest item is suspended', s.plugin.canPlayItem(item('overflow')) === true);
  Date.now = realNow;
  s.restore();
}
{
  // ── D1, THE REACHABLE PATH — and the reason the delete is NOT an equivalent mutant. ──
  //
  // The block above reaches a re-suspension by letting the first one LAPSE, which is also
  // the case suspendItem()'s in-session sweep already handles, so it does not distinguish
  // the delete. This one does, and it exists because the "the sweep makes the delete
  // redundant" argument was wrong: it assumed suspensionIsLive() is monotone in `now`, and
  // the future guard made it a WINDOW. An entry can be NOT live at the decision and live
  // again at the failure, so the sweep keeps it and the re-suspension lands on a live,
  // non-tail entry — exactly what the delete is for.
  //
  // The sequence, which is the dead-RTC-then-NTP scenario the future guard exists for:
  const day = 86400000;
  const realNow = Date.now;
  const T0 = realNow();
  Date.now = () => T0;
  const s = await freshVeto(withStore());
  const burn = (id) => {
    s.plugin.canPlayItem(item(id));
    fakeEvents.trigger(playbackManager, 'playbackerror', ['MediaDecodeError']);
  };
  burn('X');                                     // X is suspended at T0, at the Map head
  for (let i = 0; i < 99; i++) burn(`pad${i}`);  // 100 entries, X still the head
  ok('D1(window): the cap is full and X is the oldest entry',
    s.mod.vetoStatus().suspendedItems === 100, s.mod.vetoStatus().suspendedItems);

  Date.now = () => T0 - 3600000;                 // NTP corrects the clock an hour BACKWARDS
  ok('D1(window): X is no longer live, so it is vetoed again rather than stood aside',
    s.plugin.canPlayItem(item('X')) === false);

  // ...and playback fails 1 h 5 s later, by which time the clock has passed X's stored `at`
  // again. Every entry is live now, so the sweep removes NOTHING and X is re-suspended in
  // place unless the delete moves it.
  Date.now = () => T0 + 5000;
  fakeEvents.trigger(playbackManager, 'playbackerror', ['MediaDecodeError']);
  ok('D1(window): the re-suspension did not grow the store past the cap',
    s.mod.vetoStatus().suspendedItems === 100, s.mod.vetoStatus().suspendedItems);

  burn('onemore');                               // 101 -> evict whatever is at the head
  ok('D1(window): the twice-failed item SURVIVED — without the delete it is the one evicted',
    s.plugin.canPlayItem(item('X')) === true);
  ok('D1(window): and the genuine oldest single-failure item was evicted instead',
    s.plugin.canPlayItem(item('pad0')) === false);
  Date.now = realNow;
  s.restore();
}
{
  // ── N1 — THE WRITE PATH MUST NOT PRODUCE A STORE ITS OWN READ PATH DESTROYS. ────────
  //
  // SUSPEND_ID_MAX was enforced on READ only, while suspendItem() wrote whatever key was in
  // the Map, and SUSPEND_MAX_CHARS is derived assuming ids <= 64 chars. Measured on the
  // shipped code: 60 suspensions with 200-character ids wrote a 13,159-character store
  // against a 9,664 bound, so on the next load D3 refused the whole value before parsing
  // and ALL 60 entries were discarded — the well-formed ones included.
  const BOUND = 100 * 96 + 64;
  const store = withStore();
  const s = await freshVeto(store);
  const burn = (id) => {
    s.plugin.canPlayItem(item(id));
    fakeEvents.trigger(playbackManager, 'playbackerror', ['MediaDecodeError']);
  };
  const longId = (i) => `${'q'.repeat(196)}${String(i).padStart(4, '0')}`;
  for (let i = 0; i < 60; i++) burn(longId(i));
  const goodId = 'e'.repeat(32);
  burn(goodId);
  const written = String(store.map.get('jfPauseScreenVetoSuspended'));
  ok('N1: an id longer than SUSPEND_ID_MAX never reaches the store',
    !written.includes('qqqq'), written.length);
  ok('N1: the store stays inside the bound its own loader refuses to parse past',
    written.length <= BOUND, { length: written.length, BOUND });
  ok('N1: the over-long ids are STILL suspended in memory — the valve is not weakened',
    s.plugin.canPlayItem(item(longId(0))) === true);
  // The consequence that actually bites: a store the loader throws away takes the good
  // entries with it, because D3 refuses the whole value rather than the offending entry.
  const reloaded = await freshVeto(store);
  ok('N1: and the well-formed entry beside them survives a reload',
    reloaded.plugin.canPlayItem(item(goodId)) === true);
  ok('N1: which is the only entry that should have been persisted',
    reloaded.mod.vetoStatus().suspendedItems === 1, reloaded.mod.vetoStatus().suspendedItems);
  reloaded.restore();
  s.restore();
}
{
  // ── D3 — THE SIZE BOUND, PINNED FROM BOTH SIDES. ────────────────────────────────────
  //
  // An oversized store must be refused BEFORE JSON.parse: a hostile ~2 MB value cost ~98 ms
  // of synchronous parse inside canPlayItem() on an M-series Mac, so likely 0.5-2 s on a
  // low-end Android — a visible stall in the middle of player selection.
  //
  // The old fixture was ~2 MB, so ANY bound at all refused it, and the check beside it
  // ("hostile.length > 20000") asserted a property of a string the test had just built —
  // no source mutation could ever fail it. These two fixtures straddle the real bound
  // instead, so growing it or shrinking it both go red. SUSPEND_MAX_CHARS is derived in the
  // source as SUSPEND_MAX * 96 + 64; it is mirrored here rather than exported, and the
  // straddle is what keeps the mirror honest.
  const SUSPEND_MAX_CHARS = 100 * 96 + 64;
  const now = Date.now();
  const underBound = [];
  for (let i = 0; ; i++) {
    const next = [String(i).padStart(32, '0'), now];
    if (packStore([...underBound, next]).length > SUSPEND_MAX_CHARS) break;
    underBound.push(next);
  }
  const overBound = [...underBound, [String(underBound.length).padStart(32, '0'), now]];
  const firstId = underBound[0][0];
  const lastId = underBound[underBound.length - 1][0];
  {
    const s = await freshVeto(withStore(packStore(underBound)));
    ok('D3: a store just INSIDE the bound is parsed and loaded',
      s.mod.vetoStatus().suspendedItems === 100, s.mod.vetoStatus().suspendedItems);
    // ...and the FIFO trim keeps the NEWEST 100, i.e. the tail. `slice(0, SUSPEND_MAX)`
    // would keep the oldest 100 and was a surviving mutation, because every other fixture
    // in this file is under the cap.
    ok('D3: the trim keeps the newest SUSPEND_MAX entries, not the oldest',
      s.plugin.canPlayItem(item(lastId)) === true
      && s.plugin.canPlayItem(item(firstId)) === false, underBound.length);
    s.restore();
  }
  {
    const s = await freshVeto(withStore(packStore(overBound)));
    ok('D3: one entry MORE and the store is refused without parsing',
      s.mod.vetoStatus().suspendedItems === 0, s.mod.vetoStatus().suspendedItems);
    ok('D3: and player selection still works', s.plugin.canPlayItem(item('afterhostile')) === false);
    s.restore();
  }
}
{
  // The id length bound: a tampered store cannot bloat memory with giant "ids".
  const now = Date.now();
  const s = await freshVeto(withStore(packStore([
    ['x'.repeat(65), now],          // over the 64-char bound
    ['', now],                      // empty
    [12345, now],                   // not a string
    ['a'.repeat(32), now],          // a real, plausible id
    ['b'.repeat(32), 'not-a-number'],
    'a-bare-string-entry',
    ['c'.repeat(32)]                // wrong arity
  ])));
  ok('hostile store: only the one well-formed entry survives the load',
    s.mod.vetoStatus().suspendedItems === 1, s.mod.vetoStatus().suspendedItems);
  ok('hostile store: and it is the right one', s.plugin.canPlayItem(item('a'.repeat(32))) === true);
  s.restore();
}
{
  // The Array.isArray guard, plus a write that throws.
  const saved = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => `{"v":"${CONFIG.version}","s":"not an array"}`,
    setItem: () => { throw new Error('QuotaExceededError'); }
  };
  const vetoHostile = await import('../src/services/players/androidVeto.js?hostile');
  const exo3 = makeExoPlayerPlugin();
  globalThis.window.ExoPlayerPlugin = exo3;
  vetoHostile.scanAndVeto();
  // NOTE for a future mutation run: deleting the `Array.isArray(list)` guard in
  // ensureSuspendedLoaded() is an EQUIVALENT MUTANT and no check can kill it — a
  // non-array either throws on `for…of` into the same catch, or iterates to entries that
  // the per-entry shape check rejects. The guard stays because relying on a throw for
  // ordinary corrupt input is worse code, not because a test demands it.
  ok('fail-safe: a non-array store starts empty instead of throwing',
    exo3.canPlayItem(item('afteroruption')) === false);
  // This used to be an IIFE whose body ended in `return true` — a condition no source
  // mutation could falsify. Removing suspendItem()'s try/catch makes the QuotaExceededError
  // above escape through the event trigger, so catching it here is a real observation.
  ok('fail-safe: a write that throws does not propagate', (() => {
    try {
      exo3.canPlayItem(item('willburn'));
      fakeEvents.trigger(playbackManager, 'playbackerror', ['x']);
      return true;
    } catch { return false; }
  })());
  ok('fail-safe: the suspension still holds in memory for this session',
    exo3.canPlayItem(item('willburn')) === true);
  ok('fail-safe: status reports that persistence is unavailable',
    vetoHostile.vetoStatus().suspensionsPersisted === false);
  delete globalThis.window.ExoPlayerPlugin;
  globalThis.localStorage = saved;
}
{
  // The IN-SESSION sweep. An entry that lapses while the process is alive used to be
  // rewritten to the store with its original timestamp on every subsequent suspension, so
  // it held one of the 100 cap slots for the life of the process and the store was
  // permanently larger than the count vetoStatus() reported.
  const realNow = Date.now;
  const store = withStore();
  const s = await freshVeto(store);
  const burn = (id) => {
    s.plugin.canPlayItem(item(id));
    fakeEvents.trigger(playbackManager, 'playbackerror', ['MediaDecodeError']);
  };
  burn('lapses');
  Date.now = () => realNow() + 8 * 86400000;
  burn('survives');
  const written = String(store.map.get('jfPauseScreenVetoSuspended'));
  ok('store: an entry that lapsed IN SESSION is not rewritten to the store',
    !/lapses/.test(written) && /survives/.test(written), written);
  ok('store: and the persisted count matches the reported one', (() => {
    const parsed = JSON.parse(written);
    return parsed.s.length === s.mod.vetoStatus().suspendedItems;
  })(), written);
  Date.now = realNow;
  s.restore();
}
{
  // Corrupt JSON is not the same as an unavailable store: the read SUCCEEDED.
  const s = await freshVeto(withStore('}{not json at all'));
  ok('fail-safe: unparseable JSON starts empty', s.mod.vetoStatus().suspendedItems === 0);
  ok('fail-safe: but persistence is still reported as available — the read worked',
    s.mod.vetoStatus().suspensionsPersisted === true);
  s.restore();
}
{
  // A localStorage that THROWS on read is the real "unavailable" case (private mode,
  // hardened WebView), and it must be distinguishable from an empty one.
  const saved = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('SecurityError'); }
  };
  const mod = await import('../src/services/players/androidVeto.js?unreadable');
  ok('fail-safe: a store that throws on READ reports persistence unavailable',
    mod.vetoStatus().suspensionsPersisted === false);
  globalThis.localStorage = saved;
}

// ═════════════════════════════════════════════════════════════════════════════════════
// §4c F1 — THE ANDROID PLATFORM GATE
// ═════════════════════════════════════════════════════════════════════════════════════
// androidVetoMode() checks config and the three kill switches and has never checked the
// platform, so with 'auto' shipping LIVE the scan ran on Desktop, iPad and every browser.
// `NativePlayer` is in CANDIDATE_GLOBALS and is a thoroughly generic name; a
// mediaplayer-SHAPED object under it was patched immediately. B6 guards the mechanism and
// did its job — nothing guarded the platform.
{
  const savedNav = globalThis.window.navigator;
  const nativePlayer = () => ({
    type: 'mediaplayer', id: 'nativeplayer', priority: -1,
    play() {}, stop() {}, canPlayMediaType() { return true; }
  });

  globalThis.window.navigator = { userAgent: UA_DESKTOP };
  const onDesktop = await import('../src/services/players/androidVeto.js?desktop');
  const desktopPlugin = nativePlayer();
  globalThis.window.NativePlayer = desktopPlugin;
  onDesktop.scanAndVeto();
  ok('F1: a mediaplayer-shaped window.NativePlayer on DESKTOP is not patched',
    desktopPlugin.canPlayItem === undefined && onDesktop.vetoStatus().pluginsPatched === 0);
  ok('F1: and status says why', onDesktop.vetoStatus().platformAndroid === false);

  globalThis.window.navigator = { userAgent: UA_IPAD };
  const onIpad = await import('../src/services/players/androidVeto.js?ipad');
  const ipadPlugin = nativePlayer();
  globalThis.window.NativePlayer = ipadPlugin;
  onIpad.scanAndVeto();
  ok('F1: the same plugin on the iPad WebView app is not patched',
    ipadPlugin.canPlayItem === undefined && onIpad.vetoStatus().pluginsPatched === 0);

  globalThis.window.navigator = { userAgent: UA_ANDROID_WEBVIEW };
  const onAndroid = await import('../src/services/players/androidVeto.js?android');
  const androidPlugin = nativePlayer();
  globalThis.window.NativePlayer = androidPlugin;
  onAndroid.scanAndVeto();
  ok('F1: the SAME plugin on Android IS patched — this is a platform check, not a name check',
    typeof androidPlugin.canPlayItem === 'function' && onAndroid.vetoStatus().pluginsPatched === 1);

  // UA-CH, where the UA string itself has been reduced away.
  globalThis.window.navigator = { userAgent: 'Mozilla/5.0', userAgentData: { platform: 'Android' } };
  const onHints = await import('../src/services/players/androidVeto.js?hints');
  const hintsPlugin = nativePlayer();
  globalThis.window.NativePlayer = hintsPlugin;
  onHints.scanAndVeto();
  ok('F1: navigator.userAgentData.platform === "Android" is honoured on its own',
    typeof hintsPlugin.canPlayItem === 'function');

  // F10, RESTORED. guard.js documents layer 1 being tested first as "keeps localStorage out
  // of the hot path on a default install" — true while the default was 'never', which
  // terser folds away, but the SHIPPED default is now 'auto', so androidVetoMode() falls
  // through layer 1 and reads localStorage on every 100 ms boot tick. On Desktop, iPad and
  // every browser, where this feature can do nothing at all. Testing the platform FIRST is
  // what makes the documented property true again, and this is what pins that ordering.
  {
    const savedStorage = globalThis.localStorage;
    let storageReads = 0;
    globalThis.localStorage = { getItem: () => { storageReads += 1; return null; }, setItem: () => {} };
    globalThis.window.navigator = { userAgent: UA_DESKTOP };
    const ticking = await import('../src/services/players/androidVeto.js?ticks');
    for (let i = 0; i < 50; i++) ticking.scanAndVeto();
    ok('F1/F10: 50 boot ticks on a non-Android client touch localStorage zero times',
      storageReads === 0, storageReads);
    globalThis.localStorage = savedStorage;
  }

  // No navigator at all must fail CLOSED — no platform, no patch.
  globalThis.window.navigator = undefined;
  const onNoNav = await import('../src/services/players/androidVeto.js?nonav');
  const noNavPlugin = nativePlayer();
  globalThis.window.NativePlayer = noNavPlugin;
  onNoNav.scanAndVeto();
  ok('F1: an environment with no navigator fails closed', noNavPlugin.canPlayItem === undefined);

  delete globalThis.window.NativePlayer;
  globalThis.window.navigator = savedNav;
}

// ═════════════════════════════════════════════════════════════════════════════════════
// §4d The guards nothing was watching — each one below was a SURVIVING mutation
// ═════════════════════════════════════════════════════════════════════════════════════
/** A mediaplayer-SHAPED object under an arbitrary global, for the shape/policy guards. */
const shapedPlugin = (id) => ({
  type: 'mediaplayer', id, priority: -1,
  play() {}, stop() {}, canPlayMediaType() { return true; }
});

{
  // THE HTML5 GUARD. htmlVideoPlayer is the fallback the veto is trying to REACH; vetoing
  // it is how you get ErrorPlayerNotFound, i.e. no player at all. It matters most for the
  // generic `NativePlayer` slot that motivated the platform gate, where a shape check alone
  // cannot tell the fallback from the thing being replaced. Removing the check survived.
  for (const id of ['htmlvideoplayer', 'htmlaudioplayer', 'HtmlVideoPlayer']) {
    const mod = await import(`../src/services/players/androidVeto.js?html5${id}`);
    const plugin = shapedPlugin(id);
    globalThis.window.NativePlayer = plugin;
    mod.scanAndVeto();
    ok(`B6: the HTML5 player (${id}) is never vetoed — it is the fallback`,
      plugin.canPlayItem === undefined && mod.vetoStatus().pluginsPatched === 0);
    delete globalThis.window.NativePlayer;
  }
}
{
  // B6's PRIMARY DISCRIMINATOR, which nothing pinned. The file calls B6 "THE MOST IMPORTANT
  // CHECK IN THIS FILE" because patching jellyfin-android's native BRIDGE instead of the
  // plugin INSTANCE is a silent no-op that looks exactly like success. `type ===
  // 'mediaplayer'` is what separates them, and dropping that line survived all 256 checks:
  // every shaped fixture in the suite happens to carry the method trio AND the type, so the
  // trio alone was doing all the observable work.
  const trio = () => ({
    id: 'nativeplayer', priority: -1,
    play() {}, stop() {}, canPlayMediaType() { return true; }
  });
  const bridge = trio();                       // method trio, NO type — bridge-shaped
  globalThis.window.NativePlayer = bridge;
  const noType = await import('../src/services/players/androidVeto.js?notype');
  noType.scanAndVeto();
  ok('B6: an object with the whole method trio but no type is NOT patched',
    bridge.canPlayItem === undefined && noType.vetoStatus().pluginsPatched === 0);

  const instance = { ...trio(), type: 'mediaplayer' };   // identical, plus the one field
  globalThis.window.NativePlayer = instance;
  const withType = await import('../src/services/players/androidVeto.js?withtype');
  withType.scanAndVeto();
  ok('B6: the identical object WITH type: mediaplayer is patched — the field is the gate',
    typeof instance.canPlayItem === 'function' && withType.vetoStatus().pluginsPatched === 1);
  delete globalThis.window.NativePlayer;
}
{
  // THE EXTERNAL-PLAYER OPT-IN is a POLICY gate (which players the user agreed to override),
  // separate from B6's shape gate. §4 turns it ON and never turned it off again, so dropping
  // the check entirely survived — the opt-in was never actually enforced by any check.
  const savedOptIn = CONFIG.androidVetoExternalPlayer;
  CONFIG.androidVetoExternalPlayer = false;
  const optedOut = await import('../src/services/players/androidVeto.js?extoff');
  const declined = shapedPlugin('externalplayer');
  globalThis.window.ExtPlayer = declined;
  optedOut.scanAndVeto();
  ok('policy: a mediaplayer-shaped external player is NOT patched without the opt-in',
    declined.canPlayItem === undefined && optedOut.vetoStatus().pluginsPatched === 0);

  CONFIG.androidVetoExternalPlayer = true;
  const optedIn = await import('../src/services/players/androidVeto.js?exton');
  const accepted = shapedPlugin('externalplayer');
  globalThis.window.ExtPlayer = accepted;
  optedIn.scanAndVeto();
  ok('policy: and it IS patched once the opt-in is set — the gate is the flag, not the shape',
    typeof accepted.canPlayItem === 'function' && optedIn.vetoStatus().pluginsPatched === 1);
  ok('policy: status reflects the opt-in', optedIn.vetoStatus().externalPlayerOptIn === true);
  delete globalThis.window.ExtPlayer;
  CONFIG.androidVetoExternalPlayer = savedOptIn;
}
{
  // THE RUNTIME KILL SWITCHES MUST DISARM AN ALREADY-PATCHED PLUGIN. §10 exercises
  // androidVetoMode() in isolation and never re-invokes a patched canPlayItem afterwards,
  // so deleting `if (mode === 'never') return false;` from shouldVetoItem() survived: the
  // switches read as covered while the only thing they have to actually stop — a live veto
  // on a live plugin — was untested. `exo` here is the real, patched plugin from §4.
  const killKey = 'jfPauseScreenDisableUniversal';
  globalThis.localStorage.setItem(killKey, '1');
  ok('layer 3: a patched plugin stops vetoing the moment localStorage says so',
    exo.canPlayItem(directPlayItem('killswitch3')) === true);
  globalThis.localStorage.setItem(killKey, '0');
  ok('layer 3: and starts again when it is cleared',
    exo.canPlayItem(directPlayItem('killswitch3b')) === false);

  globalThis.window.__PS_DISABLE = true;
  ok('layer 2: window.__PS_DISABLE disarms a patched plugin too',
    exo.canPlayItem(directPlayItem('killswitch2')) === true);
  delete globalThis.window.__PS_DISABLE;
  ok('layer 2: and clearing it re-arms',
    exo.canPlayItem(directPlayItem('killswitch2b')) === false);
}
{
  // ── 'always' MODE MUST NOT DEFEAT THE SAFETY VALVE. ─────────────────────────────────
  //
  // shouldVetoItem() tests the suspension BEFORE the 'always' branch, and moving it below
  // survived all 256 checks. It must not: in 'always' mode a suspended item would be
  // re-vetoed on every attempt, and the per-item escape hatch — the only thing standing
  // between a wrong yes and permanently broken playback — would be switched off by a mode
  // the plan recommends. This is also the exact invariant an earlier equivalence argument
  // about suspendItem()'s delete rested on ("a live suspension is never vetoed"), so it was
  // load-bearing for the code AND for the reasoning about the code, and untested for both.
  const savedMode = CONFIG.androidForceWebPlayer;
  exo.canPlayItem(directPlayItem('valveitem'));            // vetoed in 'auto'
  fakeEvents.trigger(playbackManager, 'playbackerror', ['MediaDecodeError']);
  CONFIG.androidForceWebPlayer = 'always';
  ok("'always': a suspended item is STILL stood aside — the escape hatch outranks the mode",
    exo.canPlayItem(directPlayItem('valveitem')) === true);
  ok("'always': and lastProbe attributes it to the suspension, not to the mode",
    /suspended after a playback failure/.test((probe() || {}).reason || ''), probe());
  // 'always' RECORDS A PROBE, which was one of this round's named shape changes and had
  // nothing watching it. Without the record, a status dump in 'always' mode shows
  // lastProbe: null next to a veto, i.e. a decision with no stated reason at all.
  ok("'always': an ordinary item is vetoed and says the mode is why", (() => {
    if (exo.canPlayItem(directPlayItem('alwaysitem')) !== false) return false;
    const p = probe();
    return !!p && p.decision === 'vetoed' && p.container === null
      && /mode is always/.test(p.reason || '');
  })(), probe());
  CONFIG.androidForceWebPlayer = savedMode;
}
{
  // ── THE FAIL-CLOSED DEFAULT, which was the single most important untested site. ──────
  //
  // `safeCall(() => shouldVetoItem(…), 'veto-decide', <fallback>)` is what guarantees a bug
  // in our probe degrades to today's behaviour instead of vetoing every item on the device.
  // Nothing in the suite ever made shouldVetoItem throw, so flipping that fallback to
  // "vetoed" survived all 206 checks.
  //
  // Reading `item.Id` is a call into Jellyfin's object like any other — a property getter
  // can throw — and it used to sit OUTSIDE the wrapper, so this fixture escaped through
  // canPlayItem into player selection. It is inside now; one throw, not two.
  const hostileItem = { get Id() { throw new Error('hostile getter'); } };
  let escaped = false;
  let answer = null;
  try { answer = exo.canPlayItem(hostileItem); } catch { escaped = true; }
  ok('fail-closed: a throw inside the decision never escapes canPlayItem', escaped === false);
  ok('fail-closed: and it defaults to NOT vetoed — the native player keeps working',
    answer === true, answer);
  ok('fail-closed: the decision is still recorded, with a null id',
    veto.vetoStatus().lastDecision.vetoed === false
    && veto.vetoStatus().lastDecision.id === null, veto.vetoStatus().lastDecision);
  // A throw used to leave the PREVIOUS item's lastProbe standing next to this item's id,
  // which reads as a diagnosis and is a misattribution.
  ok('fail-closed: lastProbe is cleared, not left showing the previous item', probe() === null, probe());
}
{
  // A canPlayType() that THROWS is not the engine answering "I do not know this MIME".
  // Both decline — the outcome is identical and fail-safe — but lastProbe is a diagnostic
  // and reporting an exception as an engine answer sends the reader somewhere false.
  const savedEngine = engine;
  engine = null;                     // modelEngine() now throws inside canPlayType
  ok('lastProbe: a throwing canPlayType is reported as a throw, not as an engine verdict',
    !vetoed(item('enginethrows', { container: 'mkv' }))
    && /canPlayType threw/.test(probe().reason), probe());
  engine = savedEngine;
  ok("'auto': and the very next item is unaffected", vetoed(item('afterthrow', { container: 'mkv' })));
}

CONFIG.androidForceWebPlayer = 'never';
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
// RELATIVE TO WHAT HAS ALREADY BEEN SPENT. §4d deliberately makes two calls throw (the
// hostile Id getter and the throwing canPlayType) to test the fail-closed paths, and those
// are charged to this same process-wide budget. Hardcoding "two more throws" here would
// have silently trip it one check early. Reading errorsCaught keeps both sections honest —
// and it asserts the one property that matters in production, which is that ordinary
// operation (every storage failure in §4b included) spends NOTHING.
const BUDGET = guard.guardStatus().errorBudget;
const spentBeforeS10 = guard.guardStatus().errorsCaught;
ok('layer 4: the budget is 3 and only the two deliberate throws have been spent',
  BUDGET === 3 && spentBeforeS10 === 2, { BUDGET, spentBeforeS10 });
ok('layer 4: not disabled below the budget', guard.guardStatus().autoDisabled === false);
while (guard.guardStatus().errorsCaught < BUDGET - 1) guard.noteFailure('smoke', new Error('pad'));
ok(`layer 4: still alive at ${BUDGET - 1} throws`, guard.guardStatus().autoDisabled === false);

// ── THE LAST CHARGE IS A REAL THROW FROM REAL CODE, NOT A PAD — and it is here, at the
// very end, because the budget is process-wide and a third throw anywhere earlier tears
// the feature down under §5-§9.
//
// WHAT IT PINS (3.1). canPlayItem() builds `{ id, vetoed }` inside ONE safeCall, and the
// comment beside it used to claim "id first so a throw there still yields a usable record".
// That is false: an object literal is not partially constructed. With `Id` READABLE and
// `MediaSources` throwing, the literal aborts on the second property and safeCall's
// fallback replaces the whole thing — the readable id is discarded with it. Measured:
// lastDecision comes back {"id":null,"vetoed":false}. This check pins the real behaviour,
// so a "fix" that computed the id into a local and merged it into the fallback (two budget
// charges, and a record that half-survives a failed decision) goes red.
CONFIG.androidForceWebPlayer = 'auto';
const readableIdThrowingItem = { Id: 'goodid', get MediaSources() { throw new Error('hostile'); } };
let sourcesEscaped = false;
let sourcesAnswer = null;
try { sourcesAnswer = exo.canPlayItem(readableIdThrowingItem); } catch { sourcesEscaped = true; }
CONFIG.androidForceWebPlayer = 'never';
ok('fail-closed: a throw in the DECISION (not in the id) never escapes canPlayItem either',
  sourcesEscaped === false && sourcesAnswer === true, { sourcesEscaped, sourcesAnswer });
ok('fail-closed: and the readable id is discarded with it — the literal aborts whole',
  veto.vetoStatus().lastDecision.id === null && veto.vetoStatus().lastDecision.vetoed === false,
  veto.vetoStatus().lastDecision);
ok(`layer 4: budget exhausted at ${BUDGET}, and by a real throw`,
  guard.guardStatus().autoDisabled === true && guard.guardStatus().errorsCaught === BUDGET,
  guard.guardStatus().errorsCaught);
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
