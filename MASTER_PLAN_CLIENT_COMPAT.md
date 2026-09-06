# MASTER PLAN — Pause Screen on Jellyfin Desktop (Windows) & Jellyfin Android

Produced by three agents (author + two independent reviewers) against branch `v4.0.0`.
Server: Jellyfin **10.11.11**. Status: **plan only — no code changed.**
Working documents: `PLAN_v1.md`, `REPORT_1.md`, `REPORT_2.md`, `AGENT2_FINAL.md`, `AGENT3_FINAL.md` (session scratchpad).

---

## 1. VERDICT — the premise is wrong, and that is good news

**The 10.11.11 server upgrade did not break these clients.** Two unrelated, pre-existing
facts were mistaken for one regression:

| Client | Reality | Evidence |
|---|---|---|
| **Windows (Jellyfin Desktop)** | **Never worked. Not once.** | `native/mpvVideoPlayer.js` `createMediaElement()` builds an **empty** `div.videoPlayerContainer` (`const html = ''`) in **every** release swept: v1.9.0, v1.10.0, v1.11.0, v1.11.1, v1.12.0, v2.0.0, master. Zero `createElement('video')`. mpv wins unconditionally (`priority = -1`). |
| **Android** | Broke on an **app** update, not the server. | Commit `94dd2464` (2026-06-27) flipped the default video player `WEB_PLAYER` → `EXO_PLAYER`, shipped in **jellyfin-android v2.7.0 (2026-08-02)**. Server 10.11.11 shipped **2026-06-06** — the Android break *post-dates* the server upgrade by two months. |

Both clients load the web client **from your server**, so the script is delivered fine.
It cannot bind because in both cases **there is no `<video>` element to bind to**:

- Desktop renders through **mpv**, behind a transparent Qt WebEngine view.
- Android renders through a **native ExoPlayer** surface; `ExoPlayerPlugin.play()` calls
  `window.NativePlayer.loadPlayer(...)` and the WebView stops being the visible surface.

Our boot gate is `document.querySelector('.videoPlayerContainer video')`
(`src/main.js:13`, `:30`; `src/core/pauseScreen.js:1247`) → permanently `null` → `initPauseScreen()` never runs.

**Consequence: the two highest-value fixes are settings changes, not code.**

---

## 2. What did NOT break (verified, so we don't chase it)

- **10.11 selectors are intact.** `htmlVideoPlayer` still builds `.videoPlayerContainer` + `<video class="htmlvideoplayer">`; `.videoOsdBottom` still exists. All 37 selectors this project uses were swept against v10.10.7 and v10.11.0 — the 5 that are absent were **never** present upstream.
- **No CSP** in 10.11.11 blocking injected scripts.
- **Qt WebEngine 6.8.0 → Chromium 122** supports every JS/CSS feature this codebase uses (optional chaining, OffscreenCanvas, Workers, `backdrop-filter`, `matchMedia` pointer queries, `createObjectURL`, `AbortController`).
- **mpv `positionUpdate` fires on paused seeks** (`PlayerComponent.cpp:182` observes `playback-time` unconditionally) — plan risk R5/D6 closed.

### The one real 10.11 change — and why it is a footnote
```
10.10.7  screensavermanager.js:125   if (playbackManager.isPlayingVideo()) return;
10.11.0  screensavermanager.js:126   if (playbackManager.isPlayingVideo() && !playbackManager.paused()) return;
```
Jellyfin's own screensaver may now fire over a **paused** video. Initially rated HIGH, then
**downgraded by unanimous agreement**: it only fires if the user explicitly picked Backdrop/Logo
(default is None — `appSettings.get` is a bare `localStorage.getItem` that returns `null` and never
throws, so the `catch → backdropscreensaver` fallback is unreachable); it self-heals (500 ms
`attemptShow` retry + the slideshow's own capture-phase `mousemove` close); it is hidden behind our
`z-index: 2147483647` opaque overlay; and the setting **isn't even reachable in the Android app**.
→ **Action: one README line. No code change. Safe-zone/blocking selectors are NOT touched.**

---

## 3. GATE 0 — do this first, it can invalidate everything below

Both failing clients fetch the web client from the server, so **a wiped injection would look
exactly like a broken client**. A hand-edited `index.html` is destroyed by every server upgrade —
and you just upgraded.

**Step 1 — in a normal desktop browser** (not the app): play a video, pause, F12 → Console:
```js
(()=>{const s=[...document.scripts].map(x=>x.src||`(inline ${x.textContent.length}b)`);return{totalScripts:s.length,pauseScripts:s.filter(x=>/pause/i.test(x)),overlayInDom:!!document.getElementById('pause-overlay'),videoEl:!!document.querySelector('.videoPlayerContainer video')}})()
```
| `pauseScripts` | `overlayInDom` | Meaning |
|---|---|---|
| non-empty | `true` | Browser healthy → the diagnosis in §1 holds. Continue. |
| non-empty | `false` | Script loads but errors at runtime → capture the red stack trace first. |
| `[]` | `false` | **The upgrade wiped your injection. This is the whole bug** — and it would explain all three platforms at once. Fix this before anything else. |

**Step 2 — identify the injection mechanism** (the repo documents none; `README.md` is two lines):
```js
fetch('/web/index.html',{cache:'no-store'}).then(r=>r.text()).then(t=>console.log((t.match(/<script[^>]*>/g)||[]).join('\n')))
```
plus on the server host: `grep -n "js-pause-screen" /usr/share/jellyfin/web/index.html`
(Windows: `findstr /N "js-pause-screen" "C:\Program Files\Jellyfin\Server\jellyfin-web\index.html"`)

| served HTML | on disk | Mechanism |
|---|---|---|
| tag present | tag present | **Hand-edited `index.html`** — dies on every upgrade. Migrate to a plugin. |
| tag present | tag absent | Plugin-injected at serve time (File Transformation / JS Injector) — survives upgrades. |
| tag absent | tag absent | Not injected server-side — extension, reverse proxy, or gone. |

**Whatever the answer: write it into `README.md`.** Its absence is why this took a full investigation.

---

## 4. FIX RANKING (honest trade-offs)

### Fix 1 — Android: one tap, zero code, zero risk ✅ RECOMMENDED
App → **Settings → Video player type → "Web player"**. Play, pause → overlay returns.
*Cost:* you lose ExoPlayer's native decoding/HDR path and gain WebView playback (higher battery use,
more transcoding on some codecs). *Reversible instantly.* This is the same setting the app silently
changed for you in v2.7.0.

### Fix 2 — Desktop: `Enable MPV Player = off` ⚠️ CONDITIONAL — must pass the codec gate
Desktop → Settings → **Enable MPV Player** = off → **restart the app**. Upstream's own help text:
*"When disabled, Jellyfin will fall back to the browser's built-in HTML5 player."* That restores the
`<video>` element and the current `dist` works unmodified.

**Do not apply this blind.** Two independent hazards were found:
1. Qt WebEngine is built from **official Qt 6.8.0 binaries**, which ship **without proprietary
   codecs** (no `-webengine-proprietary-codecs` in `CMakeLists.txt`) → H.264/AAC may not decode at all.
2. Worse and more certain: `window.NativeShell` **stays defined** when MPV is off (only `getPlugins()`
   is gated, `nativeshell.js:19-35`), so `apphost.js:50-59` → `htmlVideoPlayer.js:1745-1751` keeps
   feeding the **mpv-authored device profile** — which declares unrestricted `DirectPlayProfiles`
   (`nativeshell.js:163-167`) — to the HTML5 player. Raw MKV then goes to a Chromium `<video>` that
   cannot demux it. This matches jellyfin-desktop **issue #705** ("stuck on a screen with video
   thumbnail, can't exit without restarting") exactly.
   *Mitigation if it bites:* also set **`Always Force Transcode = on`** — cost: **100% transcoding, forever, for this client.**

**60-second pre-check**, in Desktop DevTools before changing anything:
```js
document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"')  // "" = no H.264 → Fix 2 will fail
```
**GATE 2C — full codec test:** baseline an H.264+AAC file under mpv and confirm **"Direct Playing"** in
Dashboard → Active Devices → disable MPV → restart → replay the same file.
**PASS** = Direct Playing. **FAIL** = black screen / frozen thumbnail / audio-only / hang / stuttering transcode.
**Multi-user server = FAIL by policy** (one client forcing full transcodes starves everyone else).

### Fix 3 — Document the support matrix (do regardless)
Android TV is fully native — **never** supportable. Record which clients support the pause screen,
the injection mechanism from Gate 0, and the settings each client needs.

### Fix 4 — The mpv adapter — ONLY if Gate 2C fails and you want mpv quality *and* the pause screen
Reachable only when: Gate 0 clean · Desktop ≥ v2.0.0 · **Gate 2C FAILED** · overlay-over-mpv confirmed
· the item-id spike (B2.7) succeeds. Architecturally sound: `setTransparency(2)` resolves to
`dashboard.setBackdropTransparency`, so the web layer composites **above** mpv — that is how the OSD
is visible at all. Everything needed exists on `window.api.player`
(`play`/`pause`/`seekTo`/`getPosition`/`stop`; signals `playing`/`paused`/`positionUpdate`/`updateDuration`/`finished`/`stopped`).

---

## 5. Fix 4 specification (only if you get there)

**Design decision: duck-type `HTMLMediaElement` — do not invent an interface.** `detect.js` returns the
**raw `<video>` element** for HTML5, so the browser path is bit-for-bit unchanged and
`pauseScreen.js` changes by **2 lines**.

**The required surface, empirically enumerated (nine members):**
`paused` (12 uses) · `currentTime` get (8) / set (1) · `duration` (2) · `play()` (3, all `.catch()` →
must return a thenable) · `pause()` (1) · `readyState` (`:1126`) · `addEventListener`/`removeEventListener`
(7 events) · `getAttribute('poster')` (`image.js:178`).
*Confirmed unused:* `buffered`, `playbackRate`, `currentSrc`, `videoWidth/Height` (`resizeObserver` watches `document.body`).

**Critical details:**
- **Units: mpv is milliseconds**, our code is seconds. Convert **only** inside the façade (two chokepoints).
- `getPosition` is **callback-based** → keep a synchronous `currentTime` mirror fed by `positionUpdate`.
- **Coerce unknown position to `0`**, so the five `currentTime === 0` / `!== 0` sentinels
  (`:773 :796 :1042 :1074 :1083`) behave exactly as on HTML5 — otherwise `null` silently inverts them
  and two guards fail **open**.
- `window.api` is assigned **asynchronously** (`nativeshell.js:248-250`) → use `window.apiPromise`, and
  add a one-shot boot kick (a MutationObserver won't fire if the DOM is quiet when it resolves).
- `seekTo` is an async round-trip and `:1077` is read-modify-write → **optimistic local write**, or fast
  double arrow-presses clobber each other.
- Synthesize `seeked` / `loadstart` / `emptied` (no mpv equivalents); `loadedmetadata` from the first
  `updateDuration` per session. `purge()` is idempotent, so double-firing is safe.
- **Item id is a go/no-go spike, not a design** — `image.js` derives it from the poster/OSD, which mpv
  may not populate. Fall back to `playbackManager.currentItem()` / `NowPlayingItem`.

**File-by-file:** new `src/services/players/detect.js` (~60 lines) and `mpvFacade.js` (~220);
`src/main.js` (~8 changed); `src/core/pauseScreen.js` (**`:1247` + import only**);
`image.js` (1 line, only if the spike passes); `config.js` kill switch `enableMpvAdapter: false`;
version bump in `package.json` + `package-lock.json` + `config.js` in lockstep; rebuild + archive.

---

## 6. Guardrails — how we avoid breaking what works

The browser path works today; **regressing it is the single biggest risk** in this whole plan.

- **G-1 (most important).** `Archive/js-pause-screen_v4.0.0.js` is byte-identical to `dist/js-pause-screen.js`
  — a known-good baseline already exists. After any refactor, build and **diff against it**: the delta must
  be confined to boot/detect code. *This substitutes a mechanical invariant for the missing test suite.*
- **G-2.** Add `scripts/smoke.mjs` (~80 lines, no framework): build a fake `.videoPlayerContainer > video`,
  drive pause/play/seeked/loadedmetadata, assert overlay + progress width. Run the **same** assertions
  against `mpvFacade` with a stubbed `window.api.player`. Closes plan risk R7 (no tests exist).
- **G-3.** Grep-enforced contract-drift check, so new `<video>` assumptions can't creep in.
- **G-4.** Unit conversions may exist **only** inside the façade — no new `*1000` / `/1000` near
  `currentTime`/`duration` elsewhere.
- **G-5.** 15-minute browser feature-parity checklist before any Desktop work: overlay on pause,
  cleanup on episode change, backdrop cycling, blur worker, logo fade, chapter ticks, progress +
  "Ends at", our 5-min screensaver + wake/mouse-return, OSD gating, safe zones, touch tap-to-resume,
  keyboard seek, close button, portrait/tablet layouts.
- **G-6.** Ship in **two releases**: A = detect refactor only (HTML5 untouched), B = mpv façade. If A
  regresses the browser, B is not in the blast radius.
- **G-7.** `detect.js` must return `null` when `.videoPlayerContainer` exists but `window.jmpInfo` does
  not — never boot a façade in a browser.
- **G-8.** `CONFIG.enableMpvAdapter` kill switch, default `false`, so the field can disable it without
  a rebuild-and-reinject cycle.
- **Non-negotiables preserved** (`PROJECT_CONTEXT.md`): single dist file · never hand-edit `dist/` ·
  safe zones + OSD gating intact · heavy image ops stay in the worker.

---

## 7. Immediate next actions

1. **Gate 0** — run the two console probes; record the injection mechanism in `README.md`.
2. **Android** — confirm app ≥ 2.7.0 and player type; switch to **Web player**; verify overlay.
3. **Desktop** — run the `canPlayType` one-liner, then **Gate 2C** in full before touching `Enable MPV Player`.
4. Only if 2C fails **and** you want both mpv and the pause screen → authorise Fix 4 (Release A first).

**Fix 4 is not authorised by this document** — it is contingent on 2C failing and on the item-id spike.
