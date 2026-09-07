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

Forcing WebView playback costs real capability: MKV containers, AC3 audio and likely HEVC fall back
to server remux/transcode, plus higher battery use and loss of native HDR/passthrough.

`CONFIG.androidForceWebPlayer` controls this:

| Value | Behaviour |
|---|---|
| `'auto'` | **Recommended.** Veto only when the WebView would direct-play the item anyway, decided synchronously from `item.MediaSources[0]`. Zero playback cost; covers everything the phone can natively play. |
| `'always'` | Literal 100% coverage, at a transcoding cost. |
| `'never'` | Opt out. Android keeps the native player and shows no overlay. |

A `playbackerror` auto-suspends the veto for that item — degraded cosmetics beat broken playback.

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

### Pin the tag — do not use `@main`

jsDelivr serves the script with `max-age=604800, s-maxage=43200`: **7 days in each browser, 12 hours
at the CDN edge.** Consequences:

- `git push` is **not** a release. A bad build keeps serving for up to a week to anyone who already loaded it.
- `@main` is unpinned — clients get whatever `main` holds, whenever the edge happens to refresh.

So point the injector at a **pinned tag** (`@v4.2.0`). Changing the tag is then an instant,
deterministic switch — and instant rollback, because the previous tag is still on the CDN.
`https://purge.jsdelivr.net/gh/jmabini/JF-Pause-Screen@<tag>/dist/js-pause-screen.js` forces an edge
refresh, but **cannot** clear a copy already sitting in a browser.

---

## Configuration

Everything tunable lives in [`src/config.js`](src/config.js). The two flags that decide client
coverage:

| Flag | Default | Effect |
|---|---|---|
| `enableUniversalPlayer` | `false` | Capture layer + player façade. Required for Desktop-with-MPV. |
| `androidForceWebPlayer` | `'never'` | ExoPlayer veto. See the table above. |
| `androidVetoExternalPlayer` | `false` | Also veto the External Player plugin (`window.ExtPlayer`, which sorts *ahead* of ExoPlayer). Opt-in. |

All three default to off, so installing a new build changes nothing until you deliberately flip them.
Anything other than `'auto'` or `'always'` in `androidForceWebPlayer` reads as `'never'` — a typo
fails closed rather than forcing a transcode.

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

**A default-off build does not contain the feature at all.** Because layer 1 folds to a literal,
the minifier eliminates the façade, the capture layer and the veto from `dist/` entirely — in a
default build the token `Events` appears only inside `pointerEvents`, and `detectPlayerTarget`
reduces to the same one-line `querySelector` the pre-4.2.0 releases used. This is intended, and
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
3. Point the injector's user script at the new pinned tag.
4. Purge the jsDelivr edge; confirm the version marker via `window.JFPauseScreen.status()`.
5. Verify per client, **in this order**:
   - Browser — hard reload
   - Desktop — **quit and relaunch** (its cache is RAM-only; Ctrl+Shift+R is only a soft reload)
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
