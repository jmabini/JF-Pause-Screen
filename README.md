# JF Pause Screen

A custom pause overlay for Jellyfin: backdrop cycling, logo, synopsis, chapter ticks, progress and
"Ends at", plus an idle screensaver. Injected into `jellyfin-web` as a single self-contained script.

---

## Client support matrix

The overlay can only exist where Jellyfin's **web client** runs, because that is the only place an
injected script has a DOM to draw on. Native clients never load `jellyfin-web`.

| Client | Player | Supported | Mechanism |
|---|---|---|---|
| **Browser** (any OS) | HTML5 | ✅ Yes | Binds directly to `.videoPlayerContainer video` |
| **Jellyfin Desktop** (Win/macOS/Linux) | MPV *(default)* | ✅ Yes — `enableUniversalPlayer` | mpv renders behind a transparent Qt WebEngine view; there is no `<video>`, so the overlay drives Jellyfin's own player object instead |
| **Jellyfin Desktop** | MPV off | ⚠️ Not recommended | Restores a `<video>`, but ships mpv's device profile to the HTML5 player — see [jellyfin-desktop #705](https://github.com/jellyfin/jellyfin-desktop/issues/705). Leave MPV **on**. |
| **Jellyfin Android** | Web player | ✅ Yes | Real `<video>` in the WebView |
| **Jellyfin Android** | Integrated (ExoPlayer) *(default since app v2.7.0)* | ✅ Yes — `androidForceWebPlayer` | ExoPlayer stacks a native surface **above** the WebView, so the overlay has nothing to draw on. Resolved by vetoing the ExoPlayer plugin so playback falls through to the web player. |
| **Jellyfin Android** | External player | ✅ Opt-in | Same veto |
| Android TV · iOS / Swiftfin · Roku · Tizen · Chromecast | native | ❌ **Impossible** | No web client, no DOM, no injected script. Supporting these would mean forking each client app. |
| webOS | — | Reachable | Loads the web client |

### The Android trade-off

Forcing WebView playback costs real capability — but less than this file used to claim. Chromium,
and therefore Android System WebView, **does** direct-play matroska: measured on Chrome 152 and
Brave, `video/x-matroska` answers `"maybe"` and then answers codec-specifically. HEVC likewise plays
where the device has a decoder. What genuinely falls back to server remux/transcode is AC3, E-AC3
and DTS audio — plus higher battery use and the loss of native HDR and audio passthrough.

`CONFIG.androidForceWebPlayer` controls this:

| Value | Behaviour |
|---|---|
| `'auto'` | **Recommended.** Veto only when the WebView would direct-play the item anyway: build the item's real container MIME plus RFC 6381 codec ids from its media source, and ask `canPlayType()`. Zero playback cost. |
| `'always'` | Literal 100% coverage, at a transcoding cost. |
| `'never'` | Opt out. Android keeps the native player and shows no overlay. |

**What `'auto'` deliberately declines.** Declining means no overlay and the native player keeps the
item — always the safe direction, because a wrong *yes* hands the WebView a file it cannot play.

| Case | Why |
|---|---|
| 10-bit H.264 (Hi10P) | Chromium cannot decode Hi10P — and `canPlayType` answers `"probably"` even for a faithfully described Hi10P stream. The engine validates neither bit depth nor level, so this guard has to be ours. Jellyfin reports `High 10`, which the guard matches on profile alone. |
| 10-bit AV1 and VP9 — **only when the stream reports `BitDepth`** | AV1's 10-bit profile string is just `Main` and VP9's is `Profile 2`, so neither is identifiable by profile name; `BitDepth` is the only signal. Both decode in software on Chromium, so a missed case costs performance rather than playback. |
| 4:2:2 / 4:4:4 H.264 | Every codec id this module emits describes 4:2:0, and `canPlayType` answers about the *family*, so `High 4:2:2` and `High 4:4:4 Predictive` would otherwise sail through as `avc1.42E01E`. A depth guard cannot catch these — `High 4:2:2` at 8 bits has nothing wrong with its depth. Conservative: that Chromium refuses non-4:2:0 H.264 is **inferred**, not measured on a device, so the cost of being wrong here is a missing overlay on a rare file. |
| HEVC with a missing or implausible `Level` | An id is built only from a real `general_level_idc` (integral, 30–255). Anything else declines rather than guessing — `hvc1.2.4.L4.B0` claims level 0.13 and the engine still says `"probably"`. |
| VP9 in MKV | Chromium honours the legacy `"vp9"` string only inside WebM, and VP9's level is absent from Jellyfin's metadata, so a correct `vp09…` id cannot be derived. VP9 in WebM is covered; `vp8` in MKV is too. |
| AC3 · E-AC3 · DTS | Not decodable by the engine answering the probe. |
| Any unrecognised container, video codec, or audio codec | Guessing is worse than standing aside. |

A `playbackerror` auto-suspends the veto for that item — degraded cosmetics beat broken playback.
Suspensions persist across app launches (FIFO-capped at 100, 7-day TTL), so a burned item stays
suspended instead of re-breaking once per launch. Two things bound them, because `playbackerror`
also fires for transient network faults and a permanent blacklist would be worse than the bug:
the TTL, and a **build stamp** — the whole store is discarded when the script version changes, so a
fix can never be masked by a suspension recorded against an older build. In practice the build stamp
is the bound that binds; 7 days is a judgement call within a wide defensible range.

---

## Delivery pipeline

**The repo does not install itself.** The script reaches clients through a CDN and a server plugin:

```
GitHub jmabini/JF-Pause-Screen → dist/js-pause-screen.js
      ↓  jsDelivr CDN
https://cdn.jsdelivr.net/gh/jmabini/JF-Pause-Screen@<TAG>/dist/js-pause-screen.js
      ↓  JavaScript Injector plugin (v4.0.0.0+), user script "JF Pause Screen Git"
<script async src="…"> in every client that loads the web client
```

`/web/index.html` is **not** hand-edited — the injector adds the tag at request time via an ASP.NET
`IStartupFilter`, so the injection **survives server upgrades**. (A hand-edited `index.html` does not;
every upgrade wipes it. If you ever see the tag on disk, migrate it to the plugin.)

To confirm what a client is actually running, open the browser console during playback:

```js
window.JFPauseScreen.status()
```

### A constant URL never updates — not even `@latest`

jsDelivr's headers depend on whether the ref is floating or pinned. Measured 2026-09-07:

| URL form | `cache-control` | Meaning |
|---|---|---|
| `@latest`, `@main` | `max-age=604800, s-maxage=43200` | 7 days in each browser, 12 h at the edge |
| `@v4.3.0` (a tag) | `max-age=31536000, s-maxage=31536000, immutable` | **one year**, never revalidated |

Either way a constant URL is a constant *cache key*, and `@latest` resolves to the newest tag only on
a request that actually leaves the browser — and for seven days `max-age` gives the browser
permission not to make one. Pinning is not the shorter cache; it is the far longer one. That suits a
tag, whose bytes are not *meant* to change (a force-pushed tag is exactly when an `immutable` year
bites), and it is why the tag you point at must change when you want a client to move.

This is not theoretical: v4.3.0 was tagged, pushed, and live on the CDN while Desktop kept running
v4.2.0. Nothing was wrong with the build — the URL had not changed, so nothing re-fetched.

`git push` is **not** a release, and neither is tagging. **The URL changing is the release.** So the
injector appends a daily cache-busting query string, which rolls the URL once per day and picks up
the newest tag within 24 h with no injector edit:

```js
const script = document.createElement("script");
script.src = "https://cdn.jsdelivr.net/gh/jmabini/JF-Pause-Screen@latest/dist/js-pause-screen.js?d="
           + new Date().toISOString().slice(0, 10);
script.async = true;
document.head.appendChild(script);
```

- **To ship immediately** rather than within 24 h, change the string by hand — `?d=2026-09-07b`.
- **To roll back**, swap `@latest` for the previous **pinned tag**. That is a different URL, so it
  takes effect on the next load rather than waiting out a cache; and because a tag is served
  `immutable`, what you roll back to can never drift. Pinning is the only deterministic switch —
  `@latest` only rolls forward, on the CDN's schedule rather than yours. Never point a rollback at it.
- `https://purge.jsdelivr.net/gh/jmabini/JF-Pause-Screen@<tag>/dist/js-pause-screen.js` forces an
  edge refresh but **cannot** clear a copy already sitting in a browser. Only a changed URL does.

---

## Configuration

Everything tunable lives in [`src/config.js`](src/config.js). The two flags that decide client
coverage:

| Flag | Shipped value | Effect |
|---|---|---|
| `enableUniversalPlayer` | `true` *(since 4.3.0)* | Capture layer + player façade. Required for Desktop-with-MPV. |
| `androidForceWebPlayer` | `'auto'` *(since 4.3.0)* | ExoPlayer veto. See the table above. |
| `androidVetoExternalPlayer` | `false` | Also veto the External Player plugin (`window.ExtPlayer`, which sorts *ahead* of ExoPlayer). Opt-in. |

The first two shipped **off** through 4.2.0 and were turned on in 4.3.0 once Desktop was verified in
the field; `androidVetoExternalPlayer` is still opt-in. Anything other than `'auto'` or `'always'` in
`androidForceWebPlayer` reads as `'never'` — a typo fails closed rather than forcing a transcode.

**Kill switches.** Four independent layers; **any one** of them disables the universal player path:

| Layer | Where | Scope |
|---|---|---|
| `CONFIG.enableUniversalPlayer` | build-time | the build |
| `window.__PS_DISABLE = true` | runtime | that page |
| `localStorage['jfPauseScreenDisableUniversal'] = '1'` | runtime | that browser, sticky |
| 3 caught throws | automatic | that session |

They are a conjunction, not a precedence chain. Layer 1 is a **build-time constant**, so turning the
feature on or off there needs a rebuild and redeploy; the three runtime layers can only ever
*disable*, and they exist so the field can switch the feature off without that cycle.

**A build with the flag off does not contain the feature at all.** Because layer 1 folds to a
literal, the minifier eliminates the façade, the capture layer and the veto from `dist/` entirely —
in such a build the token `Events` appears only inside `pointerEvents`, and `detectPlayerTarget`
reduces to the same one-line `querySelector` the pre-4.2.0 releases used. The two flags strip
**independently**: `androidForceWebPlayer` is a string, not a boolean, so an Android-only build
(`enableUniversalPlayer: false`, `androidForceWebPlayer: 'auto'`) keeps the veto and the capture
layer while the façade is still eliminated. This is intended, and
[`scripts/smoke.mjs`](scripts/smoke.mjs) asserts it both ways: the façade must be **absent** from
`dist/` when the flag is false and **present** when it is true. An earlier attempt to keep the code
in the bundle regardless shipped 8.6 KB of provably unreachable script to every client; don't
reintroduce it.

Every guard **fails closed**: if anything is wrong, the native player keeps working and the overlay
simply doesn't appear.

---

## Build and release

```bash
npm install
npm run build      # → dist/js-pause-screen.js (single-file IIFE)
node scripts/smoke.mjs
```

Rules, all of them load-bearing:

- **Never hand-edit `dist/`.** It is a build artifact; edits are silently lost on the next build.
- **Single dist file.** No chunks, no external imports at runtime.
- **Version in lockstep** across `package.json`, `package-lock.json` and `src/config.js`.
- **Archive every release** to `Archive/js-pause-screen_v<version>.js`. After a refactor, diff the new
  build against the previous archived build — the delta must be confined to what you actually changed.
  `Archive/` is deliberately untracked and lives only on the build machine.
- **`backdropQuality` must stay ≥ 90.** Jellyfin treats ≥ 90 as "default options", so a request at or
  above the source width passes through untouched. At 89 every image forces a server-side
  decode + re-encode and a fresh 30-day cache entry, including images that needed no resizing.

### Launch-day runbook

1. Build, archive, tag, push the tag.
2. Confirm the **previous** tag still resolves on jsDelivr — that is your rollback.
3. Roll the injector's cache-busting query string (`?d=…`) so the URL actually changes.
4. Purge the jsDelivr edge; confirm the version marker via `window.JFPauseScreen.status()`.
5. Verify per client, **in this order**:
   - Browser — hard reload
   - Desktop — **quit and relaunch**. Its Qt WebEngine cache is **on disk**, not RAM-only (an earlier
     revision of this file claimed otherwise and it cost a release), so relaunching alone can still
     serve the old script. The changed query string is what actually forces the re-fetch;
     Ctrl+Shift+R is only a soft reload.
   - Android — **Settings → Storage & cache → Clear cache** (force-stop is not enough)
6. On each: check the version marker, then pause a movie, an episode, and a season-0 special.
7. Conflict pass against other player plugins (Media Bar, InPlayerEpisodePreview, Intro Skipper,
   KefinTweaks): pause, seek, skip intro, next episode.

**Abort condition:** any client shows a blank or broken overlay, or playback misbehaves → repoint the
injector at the previous tag (instant, no CDN wait) and re-verify.

---

## Notes

**Jellyfin 10.11 screensaver change.** `screensavermanager.js` changed from
`if (playbackManager.isPlayingVideo()) return;` to
`if (playbackManager.isPlayingVideo() && !playbackManager.paused()) return;`, so Jellyfin's own
screensaver may now fire over a *paused* video. In practice this is a non-issue: it only triggers if
the user explicitly selected Backdrop or Logo (the default is None), it self-heals via a 500 ms
`attemptShow` retry and the slideshow's own capture-phase `mousemove` close, it is hidden behind this
overlay's `z-index: 2147483647`, and the setting is not even reachable in the Android app. **No code
change was made for it, and the safe-zone / OSD-blocking selectors are deliberately untouched.**

**Auth.** The script reads the Jellyfin token from `localStorage` and matches it to the current origin.
If host matching fails and more than one server is stored, it **fails closed** and sends nothing,
rather than risking one server's bearer token going to another server's origin.
