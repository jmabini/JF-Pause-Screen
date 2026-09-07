/**
 * RELEASE C — ANDROID VETO
 *
 * MASTER_PLAN_V2_UNIVERSAL.md §2: on Android the façade cannot help. jellyfin-android's
 * `ActivityEventHandler.kt:62-67` handles `LaunchNativePlayer` with
 * `supportFragmentManager.addFragment<PlayerFragment>(args)`, stacking the native player
 * ABOVE the WebView. Route C would give us perfect playback state and nothing to draw on.
 *
 * So instead we veto the ExoPlayer plugin INSTANCE. `getPlayer()`
 * (playbackmanager.js:2988-3004) is pure and uncached and is re-evaluated for every
 * playback, so a per-item `canPlayItem() === false` makes selection fall through to
 * `htmlVideoPlayer` (priority 1, no canPlayItem of its own) — which then builds a real
 * <video>, and the whole overlay runs on today's unchanged code path. There is no
 * ErrorPlayerNotFound because htmlVideoPlayer always accepts.
 *
 * §5 confirms this does NOT reproduce jellyfin-desktop issue #705: ExoPlayerPlugin's
 * getDeviceProfile() is a stub and jellyfin-android's `nativeshell.js:102-104` is
 * literally `return profileBuilder()` — jellyfin-web's own WebView probe. The profile
 * follows the player.
 *
 * THE COST (§3, stated honestly): forcing WebView playback loses MKV containers, AC3
 * audio and probably HEVC to server remux/transcode, costs battery, and gives up native
 * HDR/passthrough. Hence three modes and a per-item escape hatch.
 */
import { CONFIG } from '../../config.js';
import { androidVetoMode, safeCall } from './guard.js';
import { onPlaybackError, isPlaybackErrorObserved } from './detect.js';

/** Idempotency marker on a patched plugin instance. */
const VETO_MARK = '__jfPauseScreenVetoed';

/**
 * Globals worth SHAPE-TESTING. This list only decides where to look; it never decides
 * what to patch — see looksLikeMediaPlayerPlugin() and B6 below.
 */
const CANDIDATE_GLOBALS = [
  'ExoPlayer',
  'ExoPlayerPlugin',
  'ExtPlayer',
  'ExternalPlayer',
  'ExternalPlayerPlugin',
  'NativePlayer'
];

/**
 * The external-player plugin is opt-in (§2: "Same veto, opt-in"), so it is filtered by
 * NAME here. That is a POLICY decision — which players the user agreed to override — and
 * is unrelated to B6, which governs the MECHANISM (which object is safe to patch).
 */
const EXTERNAL_PLAYER_GLOBALS = new Set(['ExtPlayer', 'ExternalPlayer', 'ExternalPlayerPlugin']);

/**
 * §3 'auto' mode: veto only when the WebView would direct-play the item anyway, so the
 * overlay costs nothing. Deliberately conservative — a false negative costs the overlay
 * on one item, a false positive costs a server transcode.
 */
const DIRECT_PLAY_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'webm']);
const VIDEO_CODEC_PROBES = {
  h264: 'video/mp4; codecs="avc1.42E01E"',
  avc: 'video/mp4; codecs="avc1.42E01E"',
  avc1: 'video/mp4; codecs="avc1.42E01E"',
  vp8: 'video/webm; codecs="vp8"',
  vp9: 'video/webm; codecs="vp9"',
  av1: 'video/mp4; codecs="av01.0.05M.08"'
};
const AUDIO_CODEC_PROBES = {
  aac: 'audio/mp4; codecs="mp4a.40.2"',
  mp3: 'audio/mpeg',
  opus: 'audio/webm; codecs="opus"',
  vorbis: 'audio/webm; codecs="vorbis"',
  flac: 'audio/mp4; codecs="flac"'
};

/** Item ids whose veto has been suspended after a playback failure (§3). */
const suspendedItemIds = new Set();
/**
 * F12: the LAST DECISION, not the last veto. `playbackerror` carries no item, so the
 * errored item has to be inferred — and the only reliable marker is the item getPlayer()
 * most recently asked us about. Recording only vetoed items got this wrong: play A
 * (vetoed, plays fine), then B (not vetoed, fails in ExoPlayer) and A would be suspended
 * while B kept failing. Recording every decision means a failure after a NON-vetoed
 * decision correctly suspends nothing — it was never our doing.
 */
let lastDecision = null; // { id, vetoed }
let patchedCount = 0;
let probeElement = null;
let errorHookInstalled = false;

function canPlay(mime) {
  if (!probeElement) probeElement = document.createElement('video');
  // canPlayType returns '' | 'maybe' | 'probably'; only '' is a definite no.
  return safeCall(() => probeElement.canPlayType(mime) !== '', 'veto-canplaytype', false);
}

/**
 * Decided synchronously from `item.MediaSources[0]`, as §3 requires — getPlayer() is a
 * synchronous call and cannot wait for a server round trip.
 *
 * ACCEPTED LIMITATION, reviewed and deliberately not fixed: `SupportsDirectPlay` /
 * `SupportsDirectStream` are computed server-side against the device profile that was
 * current when the item was fetched, so by the time getPlayer() reads them they can be
 * stale. Re-deriving them here would mean a synchronous server round trip inside player
 * selection, which is not available. The consequence of getting it wrong is one item
 * failing to play, and the `playbackerror` auto-suspend below catches exactly that.
 */
function webViewWouldDirectPlay(item) {
  const source = item && Array.isArray(item.MediaSources) ? item.MediaSources[0] : null;
  if (!source) return false;
  if (source.SupportsDirectPlay !== true && source.SupportsDirectStream !== true) return false;
  if (!DIRECT_PLAY_CONTAINERS.has(String(source.Container || '').toLowerCase())) return false;

  const streams = Array.isArray(source.MediaStreams) ? source.MediaStreams : [];
  const videoStream = streams.find(s => s && s.Type === 'Video');
  const audioStream = streams.find(s => s && s.Type === 'Audio');

  // F12 — fail closed on a missing stream list. Previously an item with no MediaStreams
  // skipped BOTH codec probes and sailed through as "direct-playable", which is the one
  // outcome 'auto' mode must never produce: it is a guess, and the cost of guessing wrong
  // is a WebView that cannot decode the item at all.
  if (!videoStream) return false;

  const videoProbe = VIDEO_CODEC_PROBES[String(videoStream.Codec || '').toLowerCase()];
  if (!videoProbe || !canPlay(videoProbe)) return false;

  // A video-only source (no audio track) is legitimate; an unrecognised audio codec is not.
  if (audioStream) {
    const audioProbe = AUDIO_CODEC_PROBES[String(audioStream.Codec || '').toLowerCase()];
    if (!audioProbe || !canPlay(audioProbe)) return false;
  }
  return true;
}

/** Should this specific item be pushed onto the web player? */
function shouldVetoItem(item) {
  const mode = androidVetoMode();
  if (mode === 'never') return false;

  const itemId = item && item.Id;
  // §3: a playbackerror auto-suspends the veto for that item — degraded cosmetics beat
  // broken playback. The suspension is per item and lasts for the session.
  if (itemId && suspendedItemIds.has(itemId)) return false;

  if (mode === 'always') return true;      // 100% coverage, at a transcoding cost
  return webViewWouldDirectPlay(item);     // 'auto': zero playback cost
}

/**
 * B6 — THE MOST IMPORTANT CHECK IN THIS FILE.
 *
 * `ExternalPlayerPlugin.js:3` is `window['ExtPlayer'] = this` — the plugin INSTANCE —
 * whereas `window.ExternalPlayer` is jellyfin-android's NATIVE BRIDGE, injected by
 * `WebViewFragment.kt:190`. Patching the bridge is a SILENT NO-OP: nothing throws,
 * nothing logs, ExoPlayer still wins, and the overlay still never appears. That is the
 * worst failure mode in this whole plan, because it looks exactly like success.
 *
 * So: feature-detect the object SHAPE, never trust a name. Only a mediaplayer plugin
 * instance carries `type === 'mediaplayer'` together with the play/stop/canPlayMediaType
 * trio; the Java bridge carries none of them.
 */
function looksLikeMediaPlayerPlugin(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  if (candidate.type !== 'mediaplayer') return false;
  if (typeof candidate.play !== 'function') return false;
  if (typeof candidate.stop !== 'function') return false;
  if (typeof candidate.canPlayMediaType !== 'function') return false;
  // Never veto the HTML5 player — it is the fallback the veto is trying to reach.
  const id = String(candidate.id || '').toLowerCase();
  if (id.includes('htmlvideoplayer') || id.includes('htmlaudioplayer')) return false;
  return true;
}

function patchPlugin(plugin) {
  if (plugin[VETO_MARK]) return false;

  const original = typeof plugin.canPlayItem === 'function' ? plugin.canPlayItem.bind(plugin) : null;

  plugin.canPlayItem = function (item, playOptions) {
    // Fail closed: any throw in here would break player selection outright, so the
    // decision is wrapped and defaults to "not vetoed" (native player keeps working).
    const veto = safeCall(() => shouldVetoItem(item), 'veto-decide', false);
    // F12: record EVERY decision, not just the vetoes — see lastDecision above.
    lastDecision = { id: (item && item.Id) || null, vetoed: veto };
    if (!veto) {
      // Absent canPlayItem means "can play anything" in getPlayer(), so preserve that.
      return original ? original(item, playOptions) : true;
    }
    return false;
  };

  plugin[VETO_MARK] = true;
  patchedCount += 1;
  return true;
}

/**
 * Scan the candidate globals and patch every shape-matching plugin instance. Cheap
 * (a handful of typeof checks), idempotent, and safe to call on every boot tick — which
 * is how it survives the fact that plugins register asynchronously, well after this
 * script runs (`html-webpack-plugin` defaults to scriptLoading:'defer', so we run first).
 */
export function scanAndVeto() {
  if (androidVetoMode() === 'never') return patchedCount;
  if (typeof window === 'undefined') return patchedCount;

  // F3 — DO NOT INSTALL THE VETO WITHOUT ITS SAFETY VALVE.
  //
  // The `playbackerror` auto-suspend (§3) is the only thing standing between this veto
  // and permanently broken playback, and it is fed entirely by the Route C capture layer.
  // Patching canPlayItem needs no Events at all, so the two used to install
  // independently: with `androidForceWebPlayer: 'auto'` and `enableUniversalPlayer: false`
  // — a combination the plan itself recommends — the veto went in while nothing was
  // listening for errors. An item that webViewWouldDirectPlay() wrongly approved would
  // then fail in htmlVideoPlayer, be re-vetoed on every retry, and never play again short
  // of clearing app data. §5 says a failed guard must do NOTHING; this is that rule.
  //
  // Arming retries every boot tick (F1), so this is a "not yet", not a "never".
  if (!isPlaybackErrorObserved()) return patchedCount;

  const allowExternal = CONFIG.androidVetoExternalPlayer === true;

  for (const name of CANDIDATE_GLOBALS) {
    if (EXTERNAL_PLAYER_GLOBALS.has(name) && !allowExternal) continue;
    const candidate = safeCall(() => window[name], 'veto-read-global', null);
    if (!looksLikeMediaPlayerPlugin(candidate)) continue; // B6: shape, never name
    safeCall(() => patchPlugin(candidate), 'veto-patch', false);
  }

  if (!errorHookInstalled) {
    errorHookInstalled = true;
    onPlaybackError(() => {
      // §3: degraded cosmetics beat broken playback. Suspend the item ONLY if the failure
      // followed a decision of ours to veto it — a failure after a decision to stand
      // aside is the native player's business, not ours (F12).
      if (lastDecision && lastDecision.vetoed && lastDecision.id) {
        suspendedItemIds.add(lastDecision.id);
      }
    });
  }

  return patchedCount;
}

/** Diagnostics for window.JFPauseScreen.status(). Never throws. */
export function vetoStatus() {
  return {
    mode: androidVetoMode(),
    externalPlayerOptIn: CONFIG.androidVetoExternalPlayer === true,
    safetyValveInstalled: isPlaybackErrorObserved(),
    pluginsPatched: patchedCount,
    lastDecision,
    suspendedItems: suspendedItemIds.size
  };
}
