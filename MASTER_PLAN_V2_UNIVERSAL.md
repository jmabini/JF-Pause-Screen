# MASTER PLAN v2 — Universal pause screen: every platform, every player, no setting dependency

Three-agent process (author + two independent reviewers), all findings verified against upstream
source at tags **v10.11.0 / v10.11.11**. Supersedes §4 of `MASTER_PLAN_CLIENT_COMPAT.md`
(the settings-level fixes), which the new requirement disqualifies. **Plan only — no code changed.**

Gate 0 is **CLOSED**: the user confirms the browser works, so injection is intact.

---

## 1. The breakthrough — one global changes everything

`jellyfin-web` `src/index.jsx:58` (byte-identical in **v10.11.0 and v10.11.11**, and it runs *before*
`loadPlugins()` at `:96`):
```js
window.Events = Events;
```
`src/utils/events.ts:25-49` exports a **plain object literal** — `trigger` is writable, not frozen —
and it is the **same singleton** every player and `playbackManager` uses. Every playback state change
in Jellyfin flows through it:
```js
Events.trigger(self, 'playbackstart', [player, state]);   // self === the playbackManager singleton
```
So injected JS can wrap `Events.trigger`, capture `playbackManager` **and the live player object**,
then unwrap itself and use the normal `Events.on(player, 'pause' | 'unpause' | 'timeupdate')` API.

**This is player-agnostic.** It works for `htmlVideoPlayer`, for **mpv**, for ExoPlayer — because it
reads Jellyfin's own playback state instead of an HTML5 `<video>` element.

Three consequences:
- **Desktop works with MPV left ON** — no adapter against `window.api`, no `<video>` required.
- **No config edit, no `NativeShell` patch, no one-shot registration deadline, no race.**
  (`html-webpack-plugin` defaults to `scriptLoading: 'defer'`, so a classic injected `<script>` runs first.)
- **The item-id problem is dead.** `state.NowPlayingItem` (`playbackmanager.js:661-675`) carries `Id`
  in the very payload we capture — including Live TV.

*Rejected alternatives:* registering a `pluginManager` plugin via `config.json` (works, but needs a
second server-file edit) or via `window.NativeShell.getPlugins()` (Desktop/Android only, hard one-shot
deadline). Route C dominates both.

---

## 2. Final architecture

| Platform / player | Mechanism | Setting-independent? |
|---|---|---|
| **Browser** (any OS) | Unchanged — `<video>` exists. **Zero code change.** | Yes |
| **Desktop — Windows / macOS / Linux, MPV ON (default)** | Route C façade | Yes |
| Desktop, MPV OFF | Normal html5 path | Yes (but see §5 — do not use MPV-off) |
| **Android — "Web player"** | Unchanged — `<video>` exists | Yes |
| **Android — "Integrated player" (ExoPlayer, default since app v2.7.0)** | **Conditional veto** → forces `htmlVideoPlayer` | Yes |
| Android — "External player" | Same veto, opt-in (`window.ExtPlayer`, `priority = -2` sorts *ahead* of ExoPlayer) | Opt-in |
| **Android TV · iOS/Swiftfin · Roku · Tizen/webOS · Chromecast** | **Impossible** — no web client, no DOM, no injected JS | N/A |

**Why Android needs a veto rather than the façade:** `ActivityEventHandler.kt:62-67` handles
`LaunchNativePlayer` with `supportFragmentManager.addFragment<PlayerFragment>(args)` — the native
player is stacked **above** the WebView. Route C would give us perfect playback state and nothing to
draw on. Vetoing `window.ExoPlayer` (the plugin *instance*, `ExoPlayerPlugin.js:3`) makes
`getPlayer()` (`playbackmanager.js:2988-3004`, pure and uncached, re-evaluated every playback) fall
through to `htmlVideoPlayer`, which has `priority = 1` and no `canPlayItem` — so it is selected, and
there is no `ErrorPlayerNotFound`.

**Blast radius is one configuration.** After the veto, Android renders through `htmlVideoPlayer` and
creates a real `<video>` — so browser, Android-veto and Android-webui all keep **today's exact code
path**. The façade runs *only* on Desktop-with-mpv.

---

## 3. The Android trade-off — your call, stated honestly

Forcing WebView playback costs real playback capability: MKV containers, AC3 audio and (likely) HEVC
fall back to server remux/transcode, plus higher battery use and loss of native HDR/passthrough.

**Recommended default: `androidForceWebPlayer: 'auto'`** — veto only when the WebView would
direct-play the item anyway (decided synchronously from `item.MediaSources[0]`). Zero playback cost,
pause screen on everything your phone can natively play.
**`'always'`** gives literal 100% coverage at a transcoding cost. **`'never'`** opts out.
Plus `playbackerror` auto-suspends the veto for that item — degraded cosmetics beat broken playback.

*This is the one place the "no matter what setting" goal has a real price. `'auto'` is the honest
default; `'always'` is one config line away if you want the overlay unconditionally.*

---

## 4. Bugs this plan exists to prevent (each verified in source)

These would all ship silently if the port were done mechanically:

| # | Trap | Evidence | Correct approach |
|---|---|---|---|
| **B1** | `getCurrentTicks()` returns **ticks, not ms** | `pbm:2256` `Math.floor(10000 * player.currentTime())` | Use `player.currentTime()` / `player.duration()` — **uniformly ms** across html5 (`:1791-1818`) and mpv (`:642-649`). One ms→s conversion, one place. (If ticks are ever used: `sec = ticks / 10_000_000`.) A literal reading was a **10,000,000× error** on progress, %, and "Ends at". |
| **B2** | `playbackManager.unpause()` returns **undefined** | `pbm:3991-3995` | Our code calls `video.play().catch()` at `:1036 :1203 :1224` → `TypeError` on **every resume**, and only on user interaction. Call the player directly or wrap in `Promise.resolve()`. |
| **B3** | `playbackManager.seek()` can **resume playback** | routes via `changeStream`, `pbm:1647-1656` | Would dismiss the overlay on arrow-key seek. Use `player.currentTime(ms)`. Also avoid `seekRelative` — upstream temporal-dead-zone bug at `:1658-1666`. |
| **B4** | mpv `currentTime()` is `undefined` before first tick, `null` after stop | `mpvVideoPlayer.js:83, :144, :247, :455` | `Math.floor(10000 * undefined)` = **NaN** → straight into clock text and a CSS width. Guard every read with `Number.isFinite()`. |
| **B5** | `currentTime === 0` sentinels break **on the façade** | mpv has no meaningful zero position; a resumed item never *is* 0 | Replace the five guards (`:773 :796 :1042 :1074 :1083`) with an explicit `hasStartedPlaying` flag driven by `playbackstart` — **on the façade path only**. See the correction below. |

> **Correction to B5 (v4.2.0, verified against this codebase).** The original rationale —
> "a transcoded stream is non-zero at position 0, because `getCurrentTicks` folds in
> `transcodingOffsetTicks` (`pbm:2248-2251`)" — is **false here**. That is `getCurrentTicks()`
> behaviour, and this project has never called it (zero hits); the five guards read
> `video.currentTime` on the raw element, which *is* 0 at the start of a transcode. The
> change is still correct, on the two surviving reasons (a resumed item never reads 0, and
> mpv has no reliable zero), but it must apply **only to the façade**: applying it to a real
> `<video>` regressed the browser path (an autoplay-blocked page flashed a full opaque
> overlay at position 0). The guards are therefore polymorphic on the target — the raw
> `<video>` keeps its original sentinel verbatim. **The code comment at
> `src/core/pauseScreen.js` (`isPauseScreenFacade`) is authoritative over this table.**
| **B6** | Wrong veto target | `ExternalPlayerPlugin.js:3` = `window['ExtPlayer']` (instance); `window.ExternalPlayer` is the **native bridge** (`WebViewFragment.kt:190`) | Patching the bridge is a **silent no-op** — the worst failure mode. **Feature-detect the object shape; never trust a name.** |
| **B7** | mpv position is cached at ~2 Hz | mpv `positionUpdate` cadence | A paused seek settles in ≤500 ms. Accept it; do not busy-poll. |

**`Events.trigger` wrap discipline:** `try { return orig.apply(...) } finally { hook() }` so upstream
throw semantics (`events.ts:9-11`) are preserved; a `[MARK]` property for idempotency; restore **only
if still outermost** (other Jellyfin userscripts stack wrappers); inert until armed; self-removes after
one capture.

---

## 5. Settled points that constrain the design

- **Desktop `Enable MPV Player = off` is structurally broken, not merely costly.** `nativeshell.js`
  `getDeviceProfile()` never references `enableMPV` (grep: 0 hits) and pushes a bare `{Type:'Video'}`
  direct-play claim (`:163-167`), so the Qt WebEngine player receives **mpv's** profile — jellyfin-desktop
  issue #705. **MPV stays ON.** Both reviewers converged here; one withdrew its earlier recommendation.
- **Android has the opposite behaviour and is safe:** `ExoPlayerPlugin.getDeviceProfile()` is a stub
  and jellyfin-android's `nativeshell.js:102-104` is literally `return profileBuilder()` — jellyfin-web's
  real WebView probe. The profile follows the player, so the veto does **not** reproduce #705.
- **Fail closed, always.** A failed guard means *do nothing*: the native player keeps working and the
  overlay simply doesn't appear — today's behaviour. Four kill-switch layers (build config →
  `window.__PS_DISABLE` → `localStorage` → auto-disable after a 3-throw error budget), a
  `JFPauseScreen.status()` surface for bug reports, and one `console.info` line on failure.

---

## 6. ONE BLOCKING PROBE before any Desktop work

**Everything in the Desktop branch depends on this.** In Desktop remote DevTools
(`"…\Jellyfin Desktop.exe" --remote-debugging-port=9222`, verified at `main.cpp:128,493-494`, then
open `http://localhost:9222`), during mpv playback:

```js
(()=>{const d=document.createElement('div');d.style.cssText='position:fixed;inset:0;background:#f0f;z-index:2147483647';document.body.appendChild(d);setTimeout(()=>d.remove(),4000);return 'magenta for 4s = PASS'})()
```

Full-screen magenta = **PASS** (an opaque DOM overlay covers mpv — expected, since `setTransparency(2)`
resolves to `dashboard.setBackdropTransparency` and the web layer composites above the video, which is
how the OSD is visible at all). Video still visible = **FAIL**, and the entire Desktop branch is void.

---

## 7. Execution order

1. **Probe §6** on Windows Desktop (2 minutes). Gates everything below.
2. **Release A — Route C, additive only.** Capture layer + façade behind `CONFIG.enableUniversalPlayer`
   (default off). Browser path must be **bit-for-bit unchanged**: build and diff against
   `Archive/js-pause-screen_v4.0.0.js`, which is byte-identical to the current `dist/`.
3. **Release B — Desktop.** Enable the façade for mpv. Verify against B1-B7 explicitly.
4. **Release C — Android veto**, default `'auto'`, with `playbackerror` auto-suspend.
5. **Regression matrix** (platform × player × feature) before each release: backdrop cycling, pre-blur
   worker, logo fade, chapter ticks, progress + "Ends at", our screensaver + wake/mouse-return, OSD
   gating, safe zones, touch tap-to-resume, keyboard seek, close button, episode/series metadata,
   portrait/tablet layouts.
6. Add `scripts/smoke.mjs` (~80 lines, no framework) — the repo has **no tests**; this is the only way
   the mpv path is testable at all.
7. Document the injection mechanism and the support matrix in `README.md` (currently two lines).

**Non-negotiables preserved:** single dist file · never hand-edit `dist/` · safe zones + OSD gating
intact · heavy image ops stay in the worker · version bumped in lockstep across `package.json`,
`package-lock.json`, `src/config.js`.

---

## 8. Honest coverage statement

**Achieved for every platform you named** — browser, Jellyfin Windows, Jellyfin Mac, Android — on
**every player setting**, with two caveats stated plainly:
- Android `'always'` mode costs transcoding; `'auto'` avoids it but only covers what the WebView can direct-play.
- The Desktop branch is contingent on the §6 probe.

**Genuinely impossible, and no amount of JS changes it:** Android TV, iOS/Swiftfin, Roku, Tizen/webOS
and Chromecast run native clients that never load jellyfin-web. There is no injected script, no DOM,
and no overlay. Supporting those would mean forking each client app.
