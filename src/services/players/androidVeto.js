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
 * THE COST (§3, stated honestly — and CORRECTED in 4.3.1): forcing WebView playback costs
 * battery, gives up native HDR/passthrough, and loses AC3/E-AC3 and DTS audio to server
 * remux/transcode. MKV IS NO LONGER ON THAT LIST. Measured 2026-09-07 against real Chrome
 * 152 and Brave (headless=new, GPU **enabled** — `--disable-gpu` makes every HEVC probe
 * return "" and will mislead you): `video/x-matroska` answers "maybe" bare and "probably"
 * for ordinary codec sets.
 *
 * WHAT THAT MEASUREMENT IS, AND WHAT IT IS NOT. It is DESKTOP macOS Chromium, and it is the
 * only thing in this file that was actually measured. Android System WebView is Chromium,
 * so the same CONTAINER registry is the strong expectation — but the C2 note below argues
 * that Android's platform DECODERS can answer differently from desktop's, and that argument
 * cuts both ways. So the bounded claim is: container support is expected to carry over,
 * codec answers are not, and NOTHING here depends on the extrapolation holding. 'auto' asks
 * the engine that is actually running, and the `playbackerror` valve catches a wrong yes.
 * Hence three modes and a per-item escape hatch.
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
 * overlay costs nothing. A false negative costs the overlay on one item; a false positive
 * costs a failed play that the `playbackerror` valve then suspends.
 *
 * ASK THE BROWSER, DON'T ASSUME. The first cut carried a hardcoded container allowlist
 * (mp4/m4v/mov/webm) and probed codecs against a MIME type unrelated to the item's actual
 * container — so an H.264-in-MKV item was asked `video/mp4; codecs="avc1…"` (yes), then
 * rejected because "mkv" wasn't in the list. Verified on a real Android device: the veto
 * installed correctly and then declined every item, because a normal library is mostly
 * MKV. The container is not a detail we get to guess about — it is exactly what
 * canPlayType() exists to answer, so build the real MIME and let the WebView decide.
 */
const CONTAINER_MIMES = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska'
  // `ts` (video/mp2t) and `ogv` (video/ogg) were drafted and dropped. Chromium only
  // recognises mp2t inside an HLS manifest, never as a standalone <video> src, so a
  // "maybe" there would be a wrong yes; and .ogv libraries are vanishingly rare while
  // Theora is not in the codec map anyway, so the entry could only ever mislead. Every
  // container we list is a chance to guess wrong, so the list stays at what we can defend.
  //
  // `mov` maps to video/mp4, which is a pre-existing choice this round did not revisit.
  // The measurement is consistent with it but does not settle it: bare `video/quicktime`
  // answers "" and so does `video/quicktime; codecs="avc1.42E01E,mp4a.40.2"`, so mapping
  // mov to its own MIME would decline every .mov. Whether the WebView actually direct-plays
  // a .mov is untested; if it does not, the `playbackerror` valve suspends the item.
};

/**
 * ══════════════════════════════════════════════════════════════════════════════════════
 * THE GOVERNING INSIGHT — read this before touching any codec id below.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * canPlayType() does NOT validate bit depth, and it does NOT sanity-check the level. It
 * parses the codec string for a KNOWN PROFILE TOKEN and then answers about the FAMILY.
 * Measured 2026-09-07 on Chrome 152 and Brave, both identical:
 *
 *   video/mp4; codecs="avc1.6E0033"          "probably"   <- H.264 High 10 (Hi10P!)
 *   video/mp4; codecs="hvc1.2.4.L4.B0"       "probably"   <- claims HEVC level 0.13
 *   video/mp4; codecs="hvc1.1.6.L29.B0"      "probably"
 *   video/mp4; codecs="hvc1.2.4.L153.5.B0"   "probably"   <- fractional level_idc
 *   video/mp4; codecs="hvc1.2.4.L1000.B0"    ""           <- only a >byte level is refused
 *
 * Chromium cannot decode Hi10P — jellyfin-web's own device profile excludes it with a
 * `NotEquals VideoProfile 'high 10'` condition — and yet the engine says "probably" for a
 * FAITHFULLY described Hi10P stream. Therefore: **asking a more precise question does not
 * protect us.** Every wrong-yes in this module has to be caught by OUR guard against
 * Jellyfin's stream metadata. It can never be delegated to the engine.
 */

/**
 * RFC 6381 codec ids, combined with the item's ACTUAL container MIME rather than a fixed
 * one. Accuracy notes, because these are the numbers that decide a real playback:
 *
 *  - `avc1.42E01E` is Baseline/L3.0 and most library files are High/L4.0+. Kept generic
 *    deliberately: H.264 decode is universal on Android, so over-describing the profile
 *    risks a wrong NO far more than a wrong YES, and Chromium does not gate H.264 support
 *    on the profile bits in practice. The ONE case where that reasoning fails is 10-bit
 *    H.264 (Hi10P), which Chromium genuinely cannot decode — see tenBitMismatch(). Do not
 *    "fix" it by emitting `avc1.6E0033`: measured, that also returns "probably".
 *  - `vp8`'s short form IS honoured in matroska (measured "probably"). `vp9`'s is NOT —
 *    see VIDEO_CODEC_IDS below. This is codec-specific, not a general rule.
 *  - HEVC is NOT in this table — see hevcCodecId(). A fixed id there would systematically
 *    under-describe exactly the files most likely to fail (4K Main10 HDR), so its id is
 *    derived from the stream's own Profile and Level or the item is declined.
 *  - `mp4a.40.2` is AAC-LC. HE-AAC is `mp4a.40.5`, but engines that decode HE also accept
 *    the LC id, and Jellyfin reports both as `aac`.
 *  - `ac-3` / `ec-3` are the ISO ids for AC3/E-AC3. They are here precisely BECAUSE they
 *    are platform-dependent: desktop Chromium says no and we decline, Android's platform
 *    decoders usually say yes and we veto. That is the whole point of asking.
 *  - `mp3` is Chromium's own alias. It is only valid in some containers; where it is not,
 *    canPlayType returns '' and we decline, which is the correct outcome.
 *  - DTS, TrueHD and Theora are deliberately absent: no engine we target decodes them, so
 *    leaving them unmapped declines the item without a probe.
 */
const VIDEO_CODEC_IDS = {
  h264: 'avc1.42E01E', avc: 'avc1.42E01E', avc1: 'avc1.42E01E',
  vp8: 'vp8',
  // VP9 DECLINES BY DESIGN, and this is not an oversight — it is C1, resolved deliberately.
  //
  // MEASURED, and this half is the only evidence here: `video/webm; codecs="vp9"` is
  // "probably" while `video/x-matroska; codecs="vp9"` is "". Both rows are in smoke.mjs's
  // MEASURED table and the model asserts them before any veto check runs. So every
  // VP9-in-MKV item declines (no overlay — fail-safe, never a broken playback).
  //
  // INFERRED, NOT VERIFIED — flagged because an earlier revision presented it as a verbatim
  // quotation from Chromium's source, and nobody on this review has opened that file: the
  // usual explanation is that the legacy short form is treated as ambiguous about profile
  // and kept working only for video/webm. Treat that as a plausible story for the
  // measurement, not as its justification. THE MEASUREMENT IS THE JUSTIFICATION, and the
  // behaviour would be identical if the explanation turned out to be something else.
  //
  // The obvious "fix" — emit `vp09.00.10.08`, which IS accepted in matroska (measured) — is
  // exactly the trap hevcCodecId() refuses to walk into: that string asserts profile 0,
  // level 1.0 and 8 bits, and a profile-2 10-bit HDR file described that way would get a
  // wrong YES (see THE GOVERNING INSIGHT).
  //
  // ALSO INFERRED: that an honest vp09 id cannot be derived because libavcodec does not
  // populate `avctx->level` for VP9 and Jellyfin therefore stores null. Nobody here read
  // libavcodec either. What we can stand behind is narrower and sufficient: this module has
  // no VP9 level to build an id from unless Jellyfin supplies one, and it declines whenever
  // it does not — the same rule hevcCodecId() applies to a missing HEVC Level. If a real
  // VP9 Level ever shows up in the wild, that is the point to revisit this, with a
  // measurement rather than an argument.
  vp9: 'vp9',
  // Hardcoded Main/L2.1/8-bit. The trailing `.08` IS the bit depth, so a 10-bit AV1 stream
  // is misdescribed by this id — which is common on AV1 — and tenBitMismatch() declines it
  // rather than letting the engine answer "probably" about the 8-bit family (A3).
  av1: 'av01.0.05M.08'
};
const AUDIO_CODEC_IDS = {
  aac: 'mp4a.40.2', mp3: 'mp3', opus: 'opus', vorbis: 'vorbis', flac: 'flac',
  ac3: 'ac-3', eac3: 'ec-3'
};

/**
 * OPEN QUESTION (C2), recorded rather than guessed at — NO behaviour depends on it.
 *
 * Measured on desktop Chromium, `video/x-matroska; codecs="avc1.42E01E,ac-3"` is "" and so
 * is the ec-3 form, so MKV+AC3 declines here today. The server may nonetheless direct-play
 * that same file: jellyfin-web probes its codec lists in `video/mp4` and then REUSES those
 * lists for its matroska DirectPlayProfile, while matroska has its own codec allowlist in
 * Chromium. If Android's platform decoders answer differently from desktop's — which is
 * the entire reason ac-3/ec-3 are in the map at all — the two could disagree and we would
 * be declining items the WebView can actually play. That is fail-safe (a missing overlay,
 * never a broken playback), and it cannot be settled without a canPlayType sweep on a real
 * Android device. Until then: change nothing here.
 */

/**
 * How many bits does the codec id we are about to EMIT actually claim?
 *
 * This is a DEPTH, not a family. The distinction is the whole of the 4.3.1 review fix: the
 * old predicate answered "is this a >=10-bit id?" and then exempted the item, so an
 * `hvc1.2.4.…` id waved through a 12-bit and a 16-bit stream as readily as a 10-bit one.
 * `hvc1.2.4.…` is profile_idc 2 / compatibility 4, i.e. HEVC Main 10, and Main 10 means
 * TEN bits — not "ten or more". Every other id this module can produce is a hardcoded
 * 8-bit description: `avc1.42E01E` (Baseline), `hvc1.1.6.…` (HEVC Main), `av01.0.05M.08`
 * (the trailing `.08` IS the bit depth), `vp8`, `vp9`.
 */
function codecIdBitDepth(codecId) {
  return /^hvc1\.2\.4\./.test(String(codecId)) ? 10 : 8;
}

/**
 * Profile names that ASSERT TEN BITS, whatever the codec.
 *
 * NOT AN ENUMERATION OF EVERY DEEP PROFILE — an earlier revision of this comment claimed
 * "there are four >8-bit profiles this module can be handed" and that was simply false; see
 * NON_420_PROFILE_RE below for the ones it missed. What this regex is, exactly: a list of
 * profile SPELLINGS that mean ten bits. Two of them exist.
 *
 *   "High 10"  — H.264 Hi10P. The id we emit for h264/avc/avc1 is `avc1.42E01E`, which says
 *                eight, so the NAME is the only signal when BitDepth is absent. This is the
 *                case the guard was written for, and the one that genuinely does not decode.
 *   "Main 10"  — HEVC Main 10, and this arm is DELIBERATELY BACK after being deleted in an
 *                earlier 4.3.1 cut.
 *
 * WHY THE `main 10` ARM CAME BACK. It was deleted on the finding that it is dead FOR HEVC,
 * and that finding stands: hevcCodecId() turns Profile "Main 10" into `hvc1.2.4.…`, an id
 * that already claims ten bits, so matching the name could never change an HEVC outcome
 * (measured over an 18,900-item differential: zero behavioural differences for hevc/h265,
 * the bad-Level and missing-Level paths included). But this predicate is applied to
 * `stream.Profile` for ANY codec, and removing the arm converted a DECLINE into a VETO for
 * every OTHER mapped codec. Measured, MKV, no BitDepth, on the shipped code with the arm
 * removed: av1 + Profile "Main 10" → vetoed as `av01.0.05M.08`; h264 + "Main 10" → vetoed as
 * `avc1.42E01E`; vp8 + "Main 10" → vetoed as `vp8`. All three are 8-bit ids describing a
 * stream whose own metadata says ten.
 *
 * That is unreachable with the probers we know of — libavcodec names H.264's deep profile
 * "High 10", AV1 uses Main/High/Professional, VP8 reports no profile, and VVC declines
 * earlier as unmapped — but "unreachable" there is a bet on other people's metadata, and the
 * arm is free defence-in-depth that can only ever DECLINE. Keeping it also stops this file
 * contradicting itself: the A2 level range check forty lines down is justified on exactly
 * the opposite premise, that some remuxers and some Jellyfin probes report the wrong thing.
 *
 * WHAT THE NAMES CANNOT COVER, stated plainly rather than enumerated as if it were complete:
 *   AV1 Main        Profile "Main"      — spans 8 AND 10 bit under one name; proves nothing.
 *   AV1 High/Prof.  Profile "High" /    — 4:4:4 and 4:2:2/12-bit respectively, so both are
 *                   "Professional"         misdescribed by `av01.0.05M.08`. NOT GUARDED: the
 *                                          names carry no depth and no chroma spelling, and
 *                                          "High" is also H.264's ordinary, universally
 *                                          decodable profile — so catching them needs a
 *                                          per-codec profile table this round did not build.
 *                                          Documented gap, not a covered case.
 *   VP9 Profile 2   Profile "Profile 2" — no depth in the name either.
 * For all of those the only signal is `BitDepth`, and if the server does not report it the
 * guard cannot fire. Accepted and documented in the README: AV1 and VP9 decode in software
 * on Chromium, so a miss there costs performance rather than a failed playback.
 */
const TEN_BIT_PROFILE_RE = /(^|\s)(high|main)\s*10/i;

/**
 * Profile names that assert a chroma subsampling NO ID THIS MODULE EMITS DESCRIBES.
 *
 * Every id in VIDEO_CODEC_IDS and every id hevcCodecId() builds is 4:2:0: `avc1.42E01E` is
 * Baseline (4:2:0 by definition), `hvc1.1.6.…`/`hvc1.2.4.…` are HEVC Main/Main 10 (both
 * 4:2:0), `av01.0.05M.08` is AV1 Main (4:2:0), and `vp8`/`vp9` are 4:2:0. So a stream whose
 * Profile spells 4:2:2 or 4:4:4 is not described by the id we are about to assert about it,
 * for the same reason a 12-bit stream is not described by a 10-bit id.
 *
 * THE HOLE THIS CLOSES, measured on the shipped code before this guard existed. MKV, no
 * BitDepth: `High 4:2:2`, `High 4:2:2 Intra`, `High 4:4:4 Predictive`, `High 4:4:4 Intra`
 * and `CAVLC 4:4:4` were ALL VETOED as `avc1.42E01E`, because h264/avc/avc1 map
 * unconditionally to that 8-bit 4:2:0 id and only `/high\s*10/` was being looked for. The
 * engine then answers "probably" — it parses for the FAMILY token, see THE GOVERNING
 * INSIGHT — and the WebView is handed a file it was never asked about.
 *
 * A DEPTH GUARD CANNOT COVER THIS: High 4:2:2 at 8 bits has nothing wrong with its depth.
 * It has to be a profile-name check.
 *
 * INFERRED, NOT MEASURED, and flagged as such: that Chromium/Android actually refuses these.
 * The argument is that Android's AVC MediaCodec decoders are 8-bit 4:2:0 in practice and
 * Chromium's own H.264 pipeline is built around 4:2:0, so a "probably" here is a plausible
 * wrong yes. Nobody on this review ran a 4:2:2 H.264 file through an Android WebView. The
 * DIRECTION is what makes the guard safe regardless of who is right: if the engine really
 * can decode 4:2:2, the cost of this guard is a missing overlay on a vanishingly rare file;
 * if it cannot, the cost of NOT having it is a broken playback. Decline, never assert
 * something false.
 *
 * The profile spellings come from libavcodec's H.264 profile names (High 4:2:2, High 4:2:2
 * Intra, High 4:4:4, High 4:4:4 Predictive, High 4:4:4 Intra, CAVLC 4:4:4) — INFERRED from
 * the strings Jellyfin surfaces, not read out of libavcodec's source by anyone here. The
 * regex matches the chroma notation itself rather than whole names, so a spelling we have
 * not seen still trips it. Optional whitespace round the colons is defensive, not observed.
 *
 * SCOPE: it is applied to every codec, which is safe because no profile name of any codec
 * this module maps spells 4:2:2 or 4:4:4 while being decodable. HEVC never reaches it —
 * hevcCodecId() only accepts "Main" and "Main 10" and declines "Main 4:2:2 10" already.
 */
const NON_420_PROFILE_RE = /4\s*:\s*2\s*:\s*2|4\s*:\s*4\s*:\s*4/;

/**
 * A1 / A3 — THE ONE GUARD EVERY HARDCODED CODEC ID GOES THROUGH.
 *
 * Returns a decline reason when the stream is deeper than the id we would emit says it is,
 * or null when the description is faithful.
 *
 * Why a guard and not a better probe: per THE GOVERNING INSIGHT above, the engine returns
 * "probably" for `avc1.6E0033` (a correctly described Hi10P stream) and for
 * `av01.0.05M.10`. It answers about the family, not about this file. So there is no
 * question we could ask canPlayType that would catch this, and the check has to live here.
 *
 * IT IS A DEPTH COMPARISON, NOT A FAMILY EXEMPTION — this is the 4.3.1 review fix. HEVC
 * Main 10 is not "exempt"; its id simply claims 10 bits, so a 10-bit Main 10 stream is
 * faithfully described and proceeds to the probe (which is what makes 4K Main10 HDR the
 * thing this module can approve rather than the thing it breaks). A TWELVE-bit Main 10
 * stream is not: `hvc1.2.4.…` claims ten, the engine answers "probably" about Main 10, and
 * the WebView is then handed a stream it cannot decode. Reproduced: MKV / Codec `hevc` /
 * Profile `Main 10` / Level 153 / BitDepth 12 emits `hvc1.2.4.L153.B0`, and real Chrome
 * answers "probably" to `video/x-matroska; codecs="hvc1.2.4.L153.B0,mp4a.40.2"`.
 *
 * The deepest signal available wins, so contradictory metadata (Profile "High 10" with
 * BitDepth 8) declines rather than being resolved in the engine's favour.
 *
 * Hi10P is essentially an MKV-only phenomenon, and MKV was never probed before 4.3.1, so
 * this defect is pre-existing but was NEWLY REACHABLE the moment matroska started probing.
 */
function tenBitMismatch(stream, codecId) {
  const idDepth = codecIdBitDepth(codecId);
  const reported = Number(stream.BitDepth);
  const byDepth = Number.isFinite(reported) && reported > 0 ? reported : 0;
  const byProfile = TEN_BIT_PROFILE_RE.test(String(stream.Profile || '')) ? 10 : 0;
  const claimed = Math.max(byDepth, byProfile);
  if (claimed <= idDepth) return null;
  // No nested quotes in this message on purpose: terser rewrites `''` to `""` inside a
  // template literal, and smoke.mjs's R6 string-literal scan then reports the resulting
  // `"}"` fragment as an unattributable new literal.
  return `${claimed}-bit video (BitDepth ${stream.BitDepth ?? 'n/a'}, Profile ${stream.Profile ?? 'n/a'})`
    + ` is not described by codec id ${codecId}`;
}

/**
 * The chroma sibling of tenBitMismatch(): same shape, same direction, different field.
 *
 * Returns a decline reason when the stream's Profile NAMES a chroma subsampling that the id
 * we are about to emit does not describe, or null when it does not. Kept separate from the
 * depth guard on purpose — depth and chroma are independent, `High 4:2:2` at 8 bits passes
 * every depth test there is, and folding them together would make the reason string lie
 * about which field decided.
 *
 * No `idChroma` parameter, because there is nothing to parameterise: every id this module
 * can emit is 4:2:0. If that ever stops being true, this needs a table, not an argument.
 */
function chromaMismatch(stream, codecId) {
  if (!NON_420_PROFILE_RE.test(String(stream.Profile || ''))) return null;
  // No nested quotes, for the same terser/R6 reason as tenBitMismatch above.
  return `Profile ${stream.Profile} is not 4:2:0 video, and codec id ${codecId} describes`
    + ` 4:2:0`;
}

/**
 * Real HEVC `general_level_idc` values, i.e. level x 30. Anything outside this range is
 * not a level at all and the item is declined rather than guessed at — see below.
 */
const HEVC_LEVEL_MIN = 30;   // L1.0
const HEVC_LEVEL_MAX = 255;  // general_level_idc is one byte

/**
 * HEVC's RFC 6381 id, derived from the stream rather than hardcoded.
 *
 * Form: hvc1.<profile_space><profile_idc>.<compatibility>.<tier><level_idc>.<constraints>
 * Main    -> profile_idc 1, compatibility 6  -> hvc1.1.6.L<level>.B0
 * Main 10 -> profile_idc 2, compatibility 4  -> hvc1.2.4.L<level>.B0
 *
 * Jellyfin's MediaStream.Level for HEVC is already general_level_idc (120 = L4.0,
 * 153 = L5.1), so it goes straight in — WHEN IT REALLY IS ONE.
 *
 * A2 — WHY THE RANGE CHECK EXISTS, stated accurately after the 4.3.1 review corrected it.
 *
 * The first cut accepted any finite level > 0, which was a straight asymmetry: an
 * unrecognised Profile was rejected outright while ANY level whatsoever was trusted. Some
 * remuxers and some Jellyfin probes report the human level (4.0) instead of
 * general_level_idc, and 4.0 builds `hvc1.2.4.L4.B0` — a claim of HEVC level 0.13.
 *
 * WHAT THIS CHECK DOES NOT DO, because an earlier revision of this comment claimed it did:
 * it does not prevent a wrong yes. Measured, the engine answers "probably" to L4, L29, L30,
 * L153, L153.5 and L255 alike — anything that fits general_level_idc's one byte. Inside
 * [1, 255] the level literally cannot change the engine's answer, so no 4K Main10 HDR file
 * is saved by range-checking it.
 *
 * WHAT IT ACTUALLY DOES: it flips items with a nonsense Level from VETO to DECLINE. That is
 * the fail-safe direction, and the justification is about the RECORD, not the engine — one
 * field we can prove is not a general_level_idc discredits the metadata we are about to
 * build a truth claim out of. We would be asserting `hvc1.2.4.L4.B0` about a file, and we
 * know that string is false. Decline, never assert something false.
 *
 * Real general_level_idc values are 30, 60, 63, 90, 93, 120, 123, 150, 153, 156, 180, 183
 * and 186; this range accepts every one of them and rejects 4, 4.0, 29, 153.5 and 1000.
 *
 * Returns `{ id }` or `{ reason }` — never a bare null. A bad Level and an unrecognised
 * Profile are DIFFERENT diagnoses and used to surface identically, as
 * `unmapped video codec "hevc"`, which is untrue (hevc is very much mapped — it is mapped
 * HERE) and sent a field reporter to VIDEO_CODEC_IDS, where a comment tells them HEVC is
 * not in that table. HEVC is plausibly the highest-volume codec in a real library and
 * lastProbe exists to make a field diagnosis a glance, so each failure says which it was.
 */
function hevcCodecId(stream) {
  const level = Number(stream.Level);
  if (!Number.isInteger(level) || level < HEVC_LEVEL_MIN || level > HEVC_LEVEL_MAX) {
    return { reason: `HEVC Level "${stream.Level}" is not a general_level_idc`
      + ` (an integer ${HEVC_LEVEL_MIN}-${HEVC_LEVEL_MAX})` };
  }
  const profile = String(stream.Profile || '').toLowerCase().replace(/\s+/g, '');
  if (profile === 'main') return { id: `hvc1.1.6.L${level}.B0` };
  if (profile === 'main10') return { id: `hvc1.2.4.L${level}.B0` };
  return { reason: `unrecognised HEVC Profile "${stream.Profile}" (only Main and Main 10`
    + ` have an id this module can build)` };
}

/** Returns `{ id }` or `{ reason }`. See hevcCodecId() for why the reason is not shared. */
function videoCodecId(stream) {
  const codec = String(stream.Codec || '').toLowerCase();
  if (codec === 'hevc' || codec === 'h265') return hevcCodecId(stream);
  const id = VIDEO_CODEC_IDS[codec];
  return id ? { id } : { reason: `unmapped video codec "${stream.Codec}"` };
}

/**
 * Item ids whose veto has been suspended after a playback failure (§3), PERSISTED WITH A
 * BOUNDED LIFETIME.
 *
 * THE TRADEOFF, BOTH WAYS — this replaced an in-memory Set and neither shape is free.
 *
 *  - Session-scoped (the old behaviour) was defensible while the probe was conservative: a
 *    mis-approved item broke once, the valve caught it, the session moved on. Now that the
 *    probe asks the engine — and engines are optimistic, HEVC and AC3 especially — it
 *    turns "breaks once" into "breaks once per app launch, forever".
 *  - Permanent persistence (the first 4.3.1 cut) is worse in the other direction, and the
 *    reason is that the trigger is not precise. detect.js subscribes to `playbackerror`
 *    unconditionally, and jellyfin-web fires it for network faults and for
 *    NoCompatibleStream, not only for decode failures. So a Wi-Fi blip during one play
 *    permanently blacklisted an item from the overlay, with no way back short of clearing
 *    app data — whereas the old in-memory Set self-healed on restart.
 *
 * A TTL is the middle: a genuine decode failure re-suspends immediately on the next
 * attempt, so the protection survives; a spurious one costs at most one failed playback
 * per item per TTL and then heals itself.
 *
 * ── WHY SEVEN DAYS. Third attempt at this paragraph, and the first one that does not argue
 * for a conclusion it cannot reach. The number is unchanged; the derivation is not.
 *
 * What it used to be anchored to, and why that is gone: the comment claimed jsDelivr serves
 * this bundle with `max-age=604800`, so a suspension could not outlive its build. MEASURED
 * 2026-09-07, wrong in both halves — `@latest`/`@main` are `max-age=604800, s-maxage=43200`
 * while a pinned tag is `max-age=31536000, immutable`, i.e. ONE YEAR, the opposite of a
 * seven-day ceiling. The CDN header was never the right anchor.
 *
 * The replacement derivation was also self-refuting, in three places, and all three are
 * fixed here rather than restated:
 *   - it argued from an ASYMMETRY (below) that the TTL should err long, and then stopped at
 *     seven days for no stated reason. That argument is monotone: it justifies thirty days
 *     just as well. An argument with no stopping point does not pick a number.
 *   - it claimed seven days is "short enough that a blip heals without waiting for a
 *     release", in the same paragraph that says the update cycle is a DAY.
 *   - it said a genuine failure "recurs once per TTL forever", which the version stamp
 *     twenty lines down had already reduced to once per UPGRADE.
 *
 * SO, HONESTLY. The asymmetry is real and it is the only thing here that is an argument:
 *   - Too SHORT: a genuinely undecodable item is re-approved and fails to play again. The
 *     user sees an error. Visible and disruptive.
 *   - Too LONG: a spurious suspension (a Wi-Fi blip — `playbackerror` fires for those too)
 *     costs the OVERLAY on one item until it lapses. Cosmetic, and mostly unnoticed.
 * A disruptive failure is worse than a cosmetic one, so err LONG. That bounds the TTL from
 * below and says nothing about where to stop, so the upper end is a JUDGEMENT CALL inside a
 * wide admissible range — anything from a couple of days to a month is defensible on this
 * reasoning alone, and seven days is a round number in the middle of it that reads as
 * "longer than one ordinary week of use". Do not treat it as derived; it is chosen.
 *
 * What actually binds is the next paragraph. The version stamp, not the TTL, is what stops
 * a suspension outliving the build that earned it, and the daily cache-buster means builds
 * turn over far faster than seven days. The TTL is the bound that matters only for a user
 * who stays on one build — and for them, erring long is the right side to err on.
 *
 * ── AND THE UPPER BOUND IS THE BUILD, ENFORCED DIRECTLY. The property the old comment
 * claimed — "a fix shipped today cannot be masked by a suspension recorded against
 * yesterday's build" — was never implemented: the store carried no build identity, so 4.3.2
 * would have honoured 4.3.1's suspensions verbatim for up to seven more days, including
 * suspensions of the very items 4.3.2 fixed. The store now stamps CONFIG.version and a
 * store written by any other version is dropped whole on load. The TTL bounds age WITHIN a
 * build; the version stamp bounds it ACROSS builds. The cost of the stamp is one extra
 * failed playback per genuinely-broken item per upgrade, which is exactly the trade the
 * claim was always describing.
 *
 * The FIFO cap stays as a THIRD, independent bound: the TTL bounds age, the version bounds
 * the build, the cap bounds size, and a hostile store satisfies none of them on its own.
 *
 * ── PER ORIGIN, NOT PER JELLYFIN USER. localStorage is scoped to the WebView's origin, and
 * every Jellyfin profile on one device shares that origin. So two users of the same server
 * on the same tablet share one suspension store: a decode failure under profile A removes
 * the overlay for that item under profile B too. Harmless — the WebView's decoders do not
 * change between profiles, so a file that failed for A would fail for B — but it was
 * undocumented, and the SUSPEND_MAX cap is therefore shared as well.
 *
 * ── KEYED PER ITEM, PROBED PER SOURCE (accepted, not fixed). pickSource() probes the
 * MediaSource the user actually chose (E2), but a suspension is recorded against the ITEM
 * id, because `playbackerror` carries neither. So a 4K remux that fails also suspends the
 * 1080p encode filed under the same Id. That is OVER-suspension: it costs the overlay on a
 * version that might have played, never a broken playback, so it is the fail-safe
 * direction. Fixing it means carrying the source id through lastDecision and widening the
 * store key and its length bound — real blast radius for a cosmetic gain, so: documented.
 *
 * Fail-safe throughout: every read and write is wrapped, a corrupt or unreadable store
 * starts empty rather than throwing, and a full or absent localStorage degrades to exactly
 * the old in-memory behaviour. Nothing here may ever break player selection.
 */
const SUSPEND_STORAGE_KEY = 'jfPauseScreenVetoSuspended';
const SUSPEND_MAX = 100;                          // size bound
const SUSPEND_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // age bound — 7 days, see above
const SUSPEND_ID_MAX = 64;                        // ids are 32-char hex; this is slack
/**
 * D3 — bail before JSON.parse on an oversized store. A hostile ~2 MB value cost ~98 ms of
 * synchronous parse INSIDE canPlayItem() on an M-series Mac, so likely 0.5-2 s on a
 * low-end Android — a visible stall in the middle of player selection.
 *
 * The bound is derived from the two constants above rather than picked: a maximal entry is
 * `["<64 chars>",1757000000000],` ≈ 83 CHARACTERS, rounded to 96 for slack, plus 64 for the
 * `{"v":"…","s":[]}` envelope. It is `String.length`, i.e. UTF-16 code units, NOT bytes —
 * named accordingly since 4.3.1, when it was called SUSPEND_MAX_BYTES and was not. The
 * direction is conservative either way: an astral-plane character costs two code units and
 * one byte of the budget more than a byte-count would allow, never less.
 *
 * N1 — AND THE DERIVATION IS NOW ENFORCED ON BOTH SIDES, which it was not. SUSPEND_ID_MAX
 * was a READ-side filter only, while suspendItem() wrote whatever key was in the Map, so
 * the write path could produce a store its own read path destroys. Measured on the shipped
 * code: 60 suspensions with 200-character ids write a 13,159-character store against a
 * 9,664 bound, and on the next load ALL 60 are discarded — the good ones included, because
 * D3 refuses the whole value before parsing. Unreachable with Jellyfin's 32-hex ids, but a
 * comment asserting a derivation the code does not enforce is exactly the defect class this
 * release is being audited for. isStorableId() below is now the single definition of "an id
 * this store will hold", and both paths use it.
 */
const SUSPEND_MAX_CHARS = SUSPEND_MAX * 96 + 64;

/**
 * N1 — THE ONE ID PREDICATE, the sibling of suspensionIsLive(). Load and write both go
 * through it, so the store can never contain a key its own loader would throw away.
 *
 * It is applied on write as a PERSISTENCE filter, not as a refusal to suspend: an id that
 * fails here is still suspended IN MEMORY for the session, it is just left out of the
 * serialised store. That asymmetry is deliberate. The safety valve exists to stop an item
 * breaking playback over and over, and weakening it — even for an id shape that cannot
 * occur — would be the one direction this module is not allowed to move in.
 *
 * WHAT `typeof id !== 'string'` DROPS, recorded rather than fixed: Jellyfin item Ids are
 * 32-char hex strings, but `item.Id` is not type-checked anywhere upstream, so a NUMERIC Id
 * survives only for the session — it used to be written and then discarded by this same
 * predicate on the next load, and it is now simply not written; the outcome a user sees is
 * identical either way. Worse, `(item && item.Id) || null` in patchPlugin() flattens
 * `Id: 0` to null, so an item with that id can never be suspended at all. Both are
 * pre-existing, both are unreachable against a real Jellyfin server, and both are left
 * alone this round: fixing them means changing what a store key IS, which is a format
 * change, not a bug fix.
 */
function isStorableId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= SUSPEND_ID_MAX;
}

/** id -> epoch ms of the suspension. A Map, so insertion order IS suspension recency. */
const suspendedAt = new Map();
let suspendedLoaded = false;
let suspendedPersisted = false;

function ensureSuspendedLoaded() {
  if (suspendedLoaded) return;
  suspendedLoaded = true;

  let raw = null;
  try {
    raw = localStorage.getItem(SUSPEND_STORAGE_KEY);
    // D4 — a SUCCESSFUL READ is the proof that persistence works, even when the store is
    // empty. The first cut returned on `if (!raw) return;` before reaching this line, so a
    // healthy fresh install reported suspensionsPersisted:false — which the field below
    // documents as meaning private mode or a hardened WebView. It said "broken" about the
    // most ordinary state there is.
    suspendedPersisted = true;
  } catch {
    // No localStorage at all (private mode, hardened WebView): start empty and stay
    // session-scoped, which is exactly the behaviour this replaced.
    suspendedPersisted = false;
    return;
  }

  try {
    if (!raw) return;
    if (raw.length > SUSPEND_MAX_CHARS) return;  // D3 — never parse a hostile store
    const parsed = JSON.parse(raw);
    // Shape: { v: <build that wrote this>, s: [[id, epochMs], …] }. Anything else — a bare
    // array (the pre-review 4.3.1 format, never shipped), a string, null — is not ours.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    // THE BUILD STAMP. A suspension is a claim about what THIS build's probe got wrong, so
    // it does not transfer to another build. Dropping the store whole is what makes the
    // guarantee in the header real rather than asserted.
    if (parsed.v !== CONFIG.version) return;
    const list = parsed.s;
    if (!Array.isArray(list)) return;
    const now = Date.now();
    for (const entry of list.slice(-SUSPEND_MAX)) {
      // Entries are [id, epochMs]. Anything without a usable timestamp is dropped rather
      // than admitted as fresh — admitting it would make it permanent, the one thing the
      // TTL exists to prevent.
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, at] = entry;
      // Length-bounded so a tampered store cannot bloat memory; ids are 32-char hex. The
      // same predicate filters the WRITE (see suspendItem), so this can only ever reject a
      // tampered or foreign store, never something we produced ourselves.
      if (!isStorableId(id)) continue;
      // THE LOAD-SIDE LIVENESS GUARD, and it is NOT redundant with the read-side one in
      // isSuspended(). A future-dated entry is refused here AND there today, but the two
      // refusals have different lifetimes: the read-side check re-evaluates every call, so
      // an entry dated 30 minutes ahead is refused at load, refused at 10 minutes of
      // uptime — and LIVE at 35 minutes, with no clock change and no new suspension, purely
      // because the stored `at` has moved into the past. The read side cannot stop that,
      // because by then the entry genuinely is live. Only refusing it at LOAD keeps it dead
      // for the session. (Measured: replacing this call with a bare `now - at <= TTL`
      // survived all 256 checks before one was written for exactly this path.)
      //
      // `typeof at !== 'number'` is an EQUIVALENT MUTANT under today's suspensionIsLive —
      // that function opens with `Number.isFinite(at)`, which does not coerce, so no string
      // and no boolean can reach the Map through it. Verified by mutation: dropping this
      // clause kills nothing. It stays for the same reason the Array.isArray guard above
      // does — it states the store's shape contract at the point the shape is read, rather
      // than leaning on a predicate two functions away to be the type check.
      if (typeof at !== 'number' || !suspensionIsLive(at, now)) continue;
      suspendedAt.set(id, at);
    }
  } catch {
    // Corrupt JSON: start empty. The store itself is still readable, so persistence is
    // genuinely available and suspendedPersisted stays true.
  }
}

/**
 * THE ONE LIFETIME PREDICATE. Load, read and write all go through it, so there is exactly
 * one place where "still suspended" is defined and the three cannot drift apart (they had:
 * load kept `at > now - TTL` while the read kept `now - at <= TTL`, a 1 ms disagreement).
 *
 * A FUTURE TIMESTAMP IS NOT A LIVE ONE — the 4.3.1 blocker. `age <= TTL` alone is satisfied
 * forever by an `at` in the future, so a single entry written while the device clock was
 * wrong became a PERMANENT blacklist that survived every restart: exactly the failure the
 * TTL was introduced to end, and a way for a tampered store to mint one past the id-length
 * and size bounds. It is not hypothetical on Android — a device with a dead RTC boots to a
 * future clock, a network blip fires `playbackerror`, NTP then corrects the clock, and that
 * item is gone from the overlay for as long as the clock offset was, with no way back short
 * of clearing app data.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════
 * THIS PREDICATE IS NOT MONOTONE IN `now`. Read this before reasoning about it.
 * ══════════════════════════════════════════════════════════════════════════════════════
 * The future guard turned it from a half-line into a WINDOW: live iff `now` is in
 * [at, at + TTL]. So "not live at T1" does NOT imply "not live at T2 > T1" — an entry with
 * a future `at` is dead now and ALIVE later, all by itself. Two separate arguments in this
 * file were built on the missing monotonicity and were wrong because of it:
 *   - "a lapsed entry is swept, so the re-suspension delete in suspendItem() is redundant"
 *     (it is not — see the scenario spelled out there);
 *   - "the read-side check makes the load-side one redundant" (it does not — see the note
 *     in ensureSuspendedLoaded()).
 * Anything of the form "it was not live earlier, therefore it is gone" is unsound here.
 *
 * NO TOLERANCE, deliberately — but NOT because the timestamp is trustworthy. An earlier
 * revision justified the strict rule with "writer and reader are the same Date.now() on the
 * same device, so `at > now` can only mean the clock moved backwards". That is false in at
 * least three ways: Android Auto Backup can restore WebView local storage onto a DIFFERENT
 * device with a different clock; the store is editable via adb or DevTools, which this
 * module already budgets for two constants up with SUSPEND_ID_MAX and SUSPEND_MAX_CHARS
 * (asserting the timestamp is trustworthy contradicts its own threat model); and several
 * Jellyfin profiles on one device share one origin and one store.
 *
 * The rule survives all three because it does not depend on provenance: DROPPING IS
 * FAIL-SAFE. A suspension we refuse costs at most one failed playback, and the item
 * re-suspends immediately on that failure — self-healing. A suspension we wrongly HONOUR
 * costs the overlay with no self-correcting path at all. So when a timestamp is not
 * something we can place in the past, the conservative answer is to refuse it, whether it
 * came from a clock correction, a restore, another profile, or a text editor.
 */
function suspensionIsLive(at, now) {
  if (!Number.isFinite(at)) return false;
  const age = now - at;
  return age >= 0 && age <= SUSPEND_TTL_MS;
}

/**
 * TTL is enforced on READ as well as on load. The Android app's WebView can stay alive for
 * days, so a load-time sweep alone would let an entry outlive its lifetime for as long as
 * the process does. Costs one Date.now() per player selection.
 *
 * Deliberately a PURE predicate — it does not evict. Eviction of lapsed entries happens in
 * suspendItem(), where it is a write anyway.
 */
function isSuspended(itemId) {
  const at = suspendedAt.get(itemId);
  return at !== undefined && suspensionIsLive(at, Date.now());
}

/** Entries that have not yet aged out. See isSuspended() for why expiry is not eager. */
function liveSuspensionCount() {
  const now = Date.now();
  let live = 0;
  for (const at of suspendedAt.values()) if (suspensionIsLive(at, now)) live += 1;
  return live;
}

function suspendItem(itemId) {
  ensureSuspendedLoaded();
  const now = Date.now();
  // Drop anything that has lapsed IN SESSION before touching the cap. Without this an
  // expired entry was rewritten to the store with its original timestamp on every
  // subsequent suspension and went on holding one of the 100 cap slots for the life of the
  // process, so the store was permanently larger than the count vetoStatus() reported.
  for (const [id, at] of suspendedAt) if (!suspensionIsLive(at, now)) suspendedAt.delete(id);
  // D1 — EVICTION IS BY RECENCY, AND Map.set() ON AN EXISTING KEY DOES NOT REORDER IT.
  // Without this delete, a re-suspension leaves the entry at its ORIGINAL position, so the
  // claim below that "the first key is the oldest" would be false for exactly the items
  // that matter most.
  //
  // AN EARLIER REVISION OF THIS COMMENT CALLED THE DELETE AN EQUIVALENT MUTANT. It is not,
  // and the argument it used is the monotonicity error documented on suspensionIsLive():
  // "a re-suspension needs the first one to have lapsed, and a lapsed entry is removed by
  // the sweep two lines up". The sweep only removes what is not live AT THIS MOMENT, and
  // suspensionIsLive is a WINDOW, so an entry can be non-live at the decision and live
  // again at the failure. Reproduced against this module:
  //
  //   1. item X fails and is suspended at T0; 99 other items are then suspended, leaving X
  //      at the head of the Map.
  //   2. the clock is corrected an hour BACKWARDS (a dead-RTC boot, then NTP — the same
  //      scenario the future guard exists for). X's `at` is now in the future, so X is not
  //      live, so X is no longer treated as suspended and is vetoed again.
  //   3. playback errors 1 h 5 s later. The clock has passed T0, so EVERYTHING is live: the
  //      sweep removes nothing, and X is a live, non-tail entry being re-suspended.
  //   4. one more distinct failure overflows the cap. WITH the delete, X has moved to the
  //      tail and the genuine oldest is evicted. WITHOUT it, X is at the head and X is
  //      evicted — the module throws away the item it has just confirmed twice is broken,
  //      keeps the oldest entry instead, and X re-breaks playback.
  //
  // The smoke test drives exactly that sequence. Keep the delete.
  suspendedAt.delete(itemId);
  suspendedAt.set(itemId, now);
  while (suspendedAt.size > SUSPEND_MAX) {
    // Map iterates in insertion order, so the first key is now genuinely the oldest.
    suspendedAt.delete(suspendedAt.keys().next().value);
  }
  try {
    // N1 — the write is filtered by the SAME id predicate the load applies, so the store can
    // never contain a key its own loader would discard, and SUSPEND_MAX_CHARS' derivation
    // ("a maximal entry is 64 id chars plus a timestamp") is a fact about this line rather
    // than an assumption about callers. Non-storable ids stay suspended in memory; see
    // isStorableId() for why the valve is not weakened to make the store tidy.
    const storable = [...suspendedAt].filter(([id]) => isStorableId(id));
    localStorage.setItem(SUSPEND_STORAGE_KEY,
      JSON.stringify({ v: CONFIG.version, s: storable }));
    suspendedPersisted = true;
  } catch {
    // Quota exceeded, private mode, hardened WebView: the suspension still holds for this
    // session, which is exactly the behaviour this replaced.
    suspendedPersisted = false;
  }
}
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

/**
 * The last direct-play evaluation, verbatim, for window.JFPauseScreen.status().
 *
 * Added because of how the v4.3.0 field bug was found: the device reported only
 * `lastDecision: { vetoed: false }`, and working out WHY took a source read and a guess.
 * One line saying which container was seen, which MIME was actually asked, and what the
 * engine answered turns that into a glance.
 */
let lastProbe = null;

function decline(container, reason) {
  lastProbe = { container, decision: 'declined', reason };
  return false;
}

/**
 * Tri-state on purpose: 'yes' | 'no' | 'threw'.
 *
 * A boolean collapsed the last two, so a canPlayType() that THREW surfaced in lastProbe as
 * "engine does not recognise this container MIME" — an exception reported as an engine
 * answer, which is the one thing a diagnostic field must never do. The OUTCOME is the same
 * either way (decline, fail-safe); only the reason differs, and the reason is the point.
 *
 * createElement is inside the wrapper too: it is a call into the host DOM like any other.
 */
function canPlay(mime) {
  return safeCall(() => {
    if (!probeElement) probeElement = document.createElement('video');
    // canPlayType returns '' | 'maybe' | 'probably'; only '' is a definite no.
    return probeElement.canPlayType(mime) !== '' ? 'yes' : 'no';
  }, 'veto-canplaytype', 'threw');
}

/**
 * E2 — the source the user is about to play, not just the first one on the item.
 *
 * `MediaSources[0]` is wrong for a multi-version item (a 4K remux and a 1080p encode under
 * one Id): playbackManager passes the chosen `mediaSourceId` in playOptions, and probing
 * the other version can approve a file the WebView cannot play, or decline one it can.
 * Pre-existing, but multi-version items are overwhelmingly an MKV phenomenon and MKV was
 * gated out before 4.3.1, so the change to probe matroska is what made this reachable.
 *
 * A NAMED-BUT-MISSING id returns null, i.e. DECLINES — it does not fall back to
 * MediaSources[0], which is what it used to do. "The caller named a source I cannot find"
 * means the record we would probe is not the record that will be played, and probing a
 * different file is how a wrong yes gets made. Same reasoning as FALLBACK B forty lines
 * below: a decline costs the overlay, a wrong yes costs the playback.
 */
function pickSource(sources, playOptions) {
  const wanted = playOptions && playOptions.mediaSourceId;
  if (wanted === undefined || wanted === null || wanted === '') return sources[0];
  return sources.find(s => s && s.Id !== undefined && String(s.Id) === String(wanted)) || null;
}

/** An audio stream by its absolute MediaStreams index, or null. Shared by both arms below. */
function audioStreamByIndex(audioStreams, wanted) {
  if (!Number.isInteger(wanted) || wanted < 0) return null;
  return audioStreams.find(s => s.Index === wanted) || null;
}

/**
 * E1 — the audio track that will actually be decoded, in Jellyfin's own order of authority.
 *
 * The first cut took `streams.find(s => s.Type === 'Audio')`, i.e. the FIRST audio stream.
 * A dual-audio release (AAC stereo first, AC3 5.1 default) then probed the wrong track and
 * answered about a codec nobody was going to play.
 *
 * Both index fields are ABSOLUTE indices into the source's own MediaStreams, matched
 * against `MediaStream.Index` — not positions within the audio tracks. The order:
 *
 *  1. `playOptions.audioStreamIndex` — the track the USER picked. getPlayer() receives
 *     playOptions, and when a user selects the AC3 track on a dual-audio item this is where
 *     that choice lives. Reading only DefaultAudioStreamIndex probed the AAC default and
 *     answered about a codec nobody was going to play — the original E1 bug, one level up.
 *     NOTE: we could not confirm from jellyfin-web's source that playbackManager forwards
 *     this field to canPlayItem in every path. So it is used DEFENSIVELY — honoured when
 *     present, ignored when absent — which is correct whether it is forwarded or not.
 *  2. `source.DefaultAudioStreamIndex` — the source's own default.
 *  3. The stream flagged `IsDefault`, which is Jellyfin's fallback when no index is set.
 *  4. The first audio track, which is all there is left.
 */
function pickAudioStream(source, streams, playOptions) {
  const audioStreams = streams.filter(s => s && s.Type === 'Audio');
  if (audioStreams.length === 0) return null;
  return audioStreamByIndex(audioStreams, playOptions && playOptions.audioStreamIndex)
    || audioStreamByIndex(audioStreams, source.DefaultAudioStreamIndex)
    || audioStreams.find(s => s.IsDefault === true)
    || audioStreams[0];
}

/**
 * Decided synchronously from the item's MediaSources, as §3 requires — getPlayer() is a
 * synchronous call and cannot wait for a server round trip.
 *
 * ACCEPTED LIMITATION, reviewed and deliberately not fixed: `SupportsDirectPlay` /
 * `SupportsDirectStream` are computed server-side against the device profile that was
 * current when the item was fetched, so by the time getPlayer() reads them they can be
 * stale. Re-deriving them here would mean a synchronous server round trip inside player
 * selection, which is not available. The consequence of getting it wrong is one item
 * failing to play, and the `playbackerror` auto-suspend below catches exactly that.
 */
function webViewWouldDirectPlay(item, playOptions) {
  const sources = item && Array.isArray(item.MediaSources) ? item.MediaSources : null;
  if (!sources || sources.length === 0) return decline(null, 'no MediaSources');
  const source = pickSource(sources, playOptions);
  if (!source) return decline(null, 'playOptions.mediaSourceId matches no MediaSource');
  const container = String(source.Container || '').toLowerCase();

  // CONTAINER AUTHORITY. On Android this flag is the server's own answer to exactly our
  // question, computed against this WebView's device profile (MASTER_PLAN_V2 §5 —
  // ExoPlayerPlugin's getDeviceProfile() is a stub, so jellyfin-android's nativeshell
  // returns profileBuilder(), jellyfin-web's own capability probe). It is a necessary
  // condition, never overridden.
  if (source.SupportsDirectPlay !== true && source.SupportsDirectStream !== true) {
    return decline(container, 'server reports neither DirectPlay nor DirectStream');
  }

  // ACCEPTED LIMITATION, DirectStream: the probe below asks about the source's ORIGINAL
  // container, but DirectStream means the server remuxes, so a DirectStream-only source is
  // not delivered in the container we are asking about. The codec half of the question
  // still holds (DirectStream copies the streams; that is what makes it DirectStream), and
  // jellyfin-web picks a remux container out of the profile it built from this same
  // WebView — so the two agree in practice. Pre-existing, and more consequential now that
  // matroska is probed at all. A wrong answer here costs one failed playback, which the
  // `playbackerror` valve suspends.

  // An unmapped container fails closed — we can't build a MIME we don't know.
  const containerMime = CONTAINER_MIMES[container];
  if (!containerMime) return decline(container, 'container not in CONTAINER_MIMES');

  const streams = Array.isArray(source.MediaStreams) ? source.MediaStreams : [];
  // BY TYPE, never by position: MediaStreams order is not a contract, and E1/E2 both exist
  // because a positional assumption about this array was wrong.
  const videoStream = streams.find(s => s && s.Type === 'Video');
  const audioStream = pickAudioStream(source, streams, playOptions);

  // F12 — fail closed on a missing stream list. Previously an item with no MediaStreams
  // skipped BOTH codec probes and sailed through as "direct-playable", which is the one
  // outcome 'auto' mode must never produce: it is a guess, and the cost of guessing wrong
  // is a WebView that cannot decode the item at all.
  if (!videoStream) return decline(container, 'no video stream in MediaStreams');

  const video = videoCodecId(videoStream);
  if (!video.id) return decline(container, video.reason);

  // A1/A3 — the bit-depth guard, applied to whatever id we just built. The engine would say
  // "probably" to all of these; see THE GOVERNING INSIGHT.
  const mismatch = tenBitMismatch(videoStream, video.id);
  if (mismatch) return decline(container, mismatch);

  // ...and its chroma sibling. Same reason, different field: `avc1.42E01E` describes 4:2:0,
  // the engine answers about the H.264 FAMILY, and High 4:2:2 / High 4:4:4 sail through a
  // depth-only guard because their depth is fine.
  const chroma = chromaMismatch(videoStream, video.id);
  if (chroma) return decline(container, chroma);

  const codecIds = [video.id];

  // A video-only source (no audio track) is legitimate; an unrecognised audio codec is not.
  if (audioStream) {
    const audioId = AUDIO_CODEC_IDS[String(audioStream.Codec || '').toLowerCase()];
    if (!audioId) return decline(container, `unmapped audio codec "${audioStream.Codec}"`);
    codecIds.push(audioId);
  }
  const codecs = codecIds.join(',');

  // THE PROBE. One question containing everything that matters: can this WebView play THIS
  // codec set in THIS container?
  //
  // A '' from the bare container MIME means the engine has no entry for that MIME string
  // at all, so the combined question below could only ever return '' too. That is a
  // decline, not a licence to re-ask somewhere else.
  //
  // FALLBACK A, DELETED IN THIS REVIEW ROUND. Until now this branch re-asked the codec
  // question in a "codec family" container (avc1 -> video/mp4, vp9 -> video/webm), on the
  // stated premise that "Chromium has no video/x-matroska entry".
  //
  // WHAT WAS MEASURED: on desktop macOS Chrome 152 and Brave, bare `video/x-matroska`
  // answers "maybe" and the container then answers codec-specifically. So the premise was
  // false on the engine we tested, every value in CONTAINER_MIMES answers non-empty there,
  // and this gate was always true there — two reviewers independently ran 15 realistic
  // items and all 15 reached the combined probe below.
  //
  // WHAT WAS NOT: Chromium is said to register the container unconditionally in
  // `media/base/mime_util_internal.cc`, outside USE_PROPRIETARY_CODECS. Nobody on this
  // review read that file. It is recorded as an UNVERIFIED explanation of the measurement,
  // not as evidence, and nothing here depends on it. Likewise the step from desktop
  // Chromium to Android System WebView is an extrapolation (see the file header): the
  // container registry is expected to carry over, decoder answers are not.
  //
  // Which is precisely why the gate STAYS rather than being deleted with the fallback. On
  // an engine that genuinely has no entry for this MIME, '' is the real answer and the
  // right response is to decline — never to re-ask the question somewhere the engine
  // happens to speak. The old reasoning is not preserved "for reference": leaving
  // confidently wrong reasoning next to the code is the exact mechanism that produced the
  // v4.3.0 field bug.
  const containerAnswer = canPlay(containerMime);
  if (containerAnswer === 'threw') return decline(container, 'canPlayType threw on the container MIME');
  if (containerAnswer === 'no') return decline(container, 'engine does not recognise this container MIME');

  const mime = `${containerMime}; codecs="${codecs}"`;
  const answer = canPlay(mime);
  if (answer === 'threw') return decline(container, 'canPlayType threw on the codec probe');
  // No `path` field: it had exactly one possible value once FALLBACK A was deleted, and a
  // field with one value still implies the alternatives it used to distinguish.
  const playable = answer === 'yes';
  lastProbe = { container, mime, decision: playable ? 'vetoed' : 'declined' };
  return playable;

  // FALLBACK B, considered and REJECTED: re-probing video-only when the combined
  // codec string is refused. Chromium parses multi-codec strings correctly, so a refusal
  // there is a real answer — usually "I cannot decode that audio codec". Accepting the
  // item on the strength of the video track alone would hand the WebView a file whose
  // audio it has just told us it cannot play. That trades a missing overlay for a broken
  // playback, which is the wrong direction for this switch.
}

/** Should this specific item be pushed onto the web player? */
function shouldVetoItem(item, playOptions) {
  const mode = androidVetoMode();
  if (mode === 'never') return false;

  const itemId = item && item.Id;
  // §3: a playbackerror auto-suspends the veto for that item — degraded cosmetics beat
  // broken playback. Per item, persisted, and TTL-bounded (see suspendItem).
  ensureSuspendedLoaded();
  // decline() also records WHY in lastProbe, so a status dump distinguishes "suspended" from
  // "the engine said no" instead of leaving the previous item's reason standing.
  if (itemId && isSuspended(itemId)) return decline(null, 'suspended after a playback failure');

  if (mode === 'always') {                               // 100% coverage, at a transcoding cost
    lastProbe = { container: null, decision: 'vetoed', reason: 'mode is always — nothing is probed' };
    return true;
  }
  return webViewWouldDirectPlay(item, playOptions);      // 'auto': zero playback cost
}

/**
 * F1 — THE PLATFORM GATE, and why a name allowlist was never one.
 *
 * androidVetoMode() checks config and the three kill switches; it has never checked the
 * PLATFORM. With `androidForceWebPlayer: 'auto'` now shipping LIVE, scanAndVeto() runs on
 * Desktop, on the iPad WebView app and in every browser, on every 100 ms boot tick.
 * CANDIDATE_GLOBALS contains `NativePlayer`, which is a thoroughly generic name: a
 * reviewer stood up a mediaplayer-shaped `window.NativePlayer` in a Desktop-shaped
 * environment and it was patched immediately. B6 guards the MECHANISM (which object is
 * safe to patch) and it did its job; nothing at all was guarding the platform.
 *
 * This is a platform check, NOT a name check — B6 stands untouched.
 *
 * `window.navigator` rather than the bare global on purpose: in a browser the two are the
 * same object, and reading it off window is what lets the harness install one.
 */
function computePlatformIsAndroid() {
  const nav = (typeof window !== 'undefined' && window && window.navigator)
    || (typeof navigator !== 'undefined' ? navigator : null);
  if (!nav) return false;
  // UA-CH first where it exists; Chromium reports platform 'Android' for the app's WebView.
  const hints = nav.userAgentData;
  if (hints && hints.platform === 'Android') return true;
  // Android System WebView's UA always carries the token, even under UA reduction.
  return /\bandroid\b/i.test(String(nav.userAgent || ''));
}

/** null until the first call; the platform cannot change inside one page lifetime. */
let platformAndroid = null;

/**
 * MEMOISED, AND IT SWALLOWS ITS OWN THROW — both for the same reason.
 *
 * This now runs FIRST in scanAndVeto(), i.e. on every 100 ms boot tick on every platform.
 * Charging that to the shared error budget would mean a navigator that throws (a hardened
 * WebView, an exotic embedder) burns all three allowances in ~300 ms and tears the pause
 * screen down — the hot-path pattern F10 exists to avoid. Deciding once, and treating a
 * throw as "not Android" forever, makes the cost one property read per session and makes
 * the "Never throws" promise in vetoStatus()'s docstring literally true.
 */
function platformIsAndroid() {
  if (platformAndroid === null) {
    try { platformAndroid = computePlatformIsAndroid(); } catch { platformAndroid = false; }
  }
  return platformAndroid;
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
    // Cleared FIRST so lastProbe always describes THIS decision or nothing at all. If the
    // evaluation below throws, a status dump used to show the PREVIOUS item's reason next
    // to this item's id, which reads as a diagnosis and is a misattribution.
    lastProbe = null;
    // Fail closed: any throw in here would break player selection outright, so the
    // decision is wrapped and defaults to "not vetoed" (native player keeps working).
    // `vetoed: false` in that fallback is the single most important value in this module —
    // it is what makes a bug in our probe degrade to today's behaviour instead of vetoing
    // every item on the device. Do not "simplify" it to true.
    //
    // READING item.Id IS INSIDE THE WRAPPER, and that is not cosmetic: `item` is Jellyfin's
    // object, a property getter can throw, and this read used to sit outside — so a
    // throwing Id escaped canPlayItem straight into player selection, which is the one
    // thing this whole directory promises never to do. One wrapped evaluation, one charge
    // against the error budget.
    //
    // THE PROPERTY ORDER IS NOT LOAD-BEARING, and an earlier revision of this comment said
    // it was: "id first so a throw there still yields a usable record". Measured — `Id`
    // readable as 'goodid', `MediaSources` throwing — lastDecision comes back as
    // `{ id: null, vetoed: false }`. An object literal is not partially constructed: the
    // throw aborts the whole expression and safeCall's fallback replaces it, id included.
    // Swapping the two properties survived all 256 checks, and the one place the order
    // could in principle show (a throw between them leaving lastProbe set) does not, because
    // shouldVetoItem() reads `item.Id` itself before it can record anything. So: the FIX —
    // both reads inside one wrapper — is what matters; the order is arbitrary. What IS
    // pinned by a check is the measured behaviour above: any throw in here yields the
    // fallback record WHOLE, so a readable id is discarded along with the decision.
    //
    // F12: record EVERY decision, not just the vetoes — see lastDecision above.
    const decision = safeCall(() => ({
      id: (item && item.Id) || null,
      vetoed: shouldVetoItem(item, playOptions)
    }), 'veto-decide', { id: null, vetoed: false });
    lastDecision = decision;
    if (!decision.vetoed) {
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
  if (typeof window === 'undefined') return patchedCount;

  // F1 — THE PLATFORM GATE, and it goes FIRST, ahead of androidVetoMode().
  //
  // guard.js documents F10's benefit as "keeps localStorage out of the hot path on a default
  // install", and that was true while the default was androidForceWebPlayer:'never', which
  // terser folds away. The shipped default is now 'auto', so androidVetoMode() falls THROUGH
  // its layer-1 check and reads localStorage — on every 100 ms boot tick, on Desktop, iPad
  // and every browser, none of which this feature can do anything on. The platform is a
  // memoised property read (see platformIsAndroid), so testing it first restores the stated
  // property on every non-Android client. Android still pays exactly what it did.
  if (!safeCall(platformIsAndroid, 'veto-platform', false)) return patchedCount;

  if (androidVetoMode() === 'never') return patchedCount;

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
        suspendItem(lastDecision.id);
      }
    });
  }

  return patchedCount;
}

/** Diagnostics for window.JFPauseScreen.status(). Never throws. */
export function vetoStatus() {
  // D4: without this, the count read 0 before the first player decision and the true value
  // afterwards, and suspensionsPersisted reported the pre-load default rather than a fact.
  // Loading is idempotent and costs one localStorage read, once per session.
  ensureSuspendedLoaded();
  return {
    mode: androidVetoMode(),
    platformAndroid: platformIsAndroid(),
    externalPlayerOptIn: CONFIG.androidVetoExternalPlayer === true,
    safetyValveInstalled: isPlaybackErrorObserved(),
    pluginsPatched: patchedCount,
    lastDecision,
    lastProbe,
    suspendedItems: liveSuspensionCount(),
    suspensionTtlDays: SUSPEND_TTL_MS / 86400000,
    // false means the store is unavailable (private mode / quota / hardened WebView), so
    // suspensions are session-only again. Worth knowing in a bug report.
    suspensionsPersisted: suspendedPersisted,
    suspensionStorageKey: SUSPEND_STORAGE_KEY
  };
}
