# VideoContext App — Chrome Extension

> Turn screen recordings into AI-ready context. Record your screen, extract the most useful frames, paste them into Claude, ChatGPT, or Gemini.

Video isn't a supported input in any major LLM today. VideoContext records a portion of your screen, extracts the most useful frames as PNGs, stitches them into a single grid image, and copies that to your clipboard. One paste delivers the whole sequence to the model.

Part of the [VideoContext](https://videocontext.app) suite. A native macOS menu-bar app for system-wide capture is in development.

---

## Features

- **Tab / Window / Screen capture** via Chrome's native picker.
- **Optional area select** — draw a rectangle to crop every frame.
- **Three duration presets** that all target 10 frames:
  - Quick — 5s, 2 fps. UI demos, error screens.
  - Standard — 10s, 1 fps. Walkthroughs, multi-step flows.
  - Slow — 20s, 0.5 fps. Long processes, slow-moving content.
- **3-2-1 countdown** so you can set the stage before capture starts.
- **Copy as Grid** — selected frames stitched into one watermarked PNG, written to clipboard. One paste, all frames.
- **Save PNGs (zip)** — bulk export selected frames as `frame-001.png`, `frame-002.png`, … inside a single archive.
- **100% offline.** No accounts, no servers, no telemetry. Frames live in browser memory and are dropped when you close the widget.

---

## Install

### From the Chrome Web Store

Listing pending. Once approved, install will be one click.

### From source (unpacked)

1. Clone or download this repo.
2. Open `chrome://extensions` in Chrome.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
5. Pin the VideoContext icon to your toolbar for one-click access.

---

## Using it

1. Click the toolbar icon — the floating recorder card appears top-right of the active tab.
2. Pick a capture mode (**Tab**, **Window**, or **Screen**).
3. Pick a duration preset (**Quick**, **Standard**, or **Slow**).
4. Optionally click **Select area** and drag a rectangle to crop every frame.
5. Click **Start Recording** → Chrome's picker appears → choose a source.
6. After the 3-2-1 countdown, capture runs and auto-stops at the preset duration. You can hit **Stop** on the left-edge strip at any time.
7. Review the frame grid. Toggle individual frames or use **Select all**.
8. Click **Copy as Grid ★** to put the stitched PNG on your clipboard, or **Save PNGs (zip)** to download the archive.
9. Paste into Claude / ChatGPT / Gemini and ask away.

Click the toolbar icon a second time to hide the widget; click again to bring it back.

---

## Permissions

| Permission | Reason |
|---|---|
| `desktopCapture` | Show Chrome's screen / window / tab picker. |
| `clipboardWrite` | Write the stitched grid PNG to your clipboard. |
| `scripting` | Inject the recorder widget into the active tab when you click the toolbar icon. |
| `activeTab` | Grants single-tab access only while you have the extension open. No `<all_urls>` host permission. |
| `storage` | Reserved for future preference persistence. Not read or written by the current build. |

No remote code is loaded. All scripts ship inside the package.

---

## Privacy

Nothing leaves your machine. The extension has no backend, no analytics, no third-party scripts. Captured frames are held as object URLs in browser memory during a session and are released when you close the widget or navigate away.

Full policy: <https://videocontext.app/privacy.html>

---

## Architecture (quick tour)

- **`manifest.json`** — Manifest V3. Action button, background service worker, the five permissions above.
- **`background.js`** — Service worker. Injects `content.js` on icon click (toggling visibility on re-injection), and opens the `chrome.desktopCapture` picker on request, routing the `streamId` back via a long-lived port.
- **`content.js`** — The whole user-facing widget. Mounted inside a Shadow DOM so host-page CSS can't leak in. Handles the UI, area-select overlay, countdown, `getUserMedia` setup, frame extraction (`<canvas>` + `toBlob`), collage stitching with a `videocontext.app` watermark, clipboard write, and a tiny inline ZIP writer for the Save action.
- **`icons/`** — 16/48/128 toolbar icons.

For the full design rationale (LLM image limits, frame-count strategy, storage policy, monetisation, Mac-app architecture) see [`VideoContext_project.md`](../VideoContext_project.md).

---

## Development

This extension is intentionally **zero-build**. There is no bundler, no transpiler, no `node_modules`. Edit a `.js` file, click reload on `chrome://extensions`, and your change is live.

### Packaging for the Chrome Web Store

```sh
cd /path/to/videocontext-extension
# Sanity check — these are the only files that should be shipped:
ls
# manifest.json  background.js  content.js  icons/  README.md

zip -r videocontext-app-<version>.zip . \
    -x '.DS_Store' '**/.DS_Store' '__MACOSX/*' 'README.md'
```

`README.md` is excluded from the upload — it's for GitHub readers, not for the published extension. See `CHROME_STORE.md` in the umbrella project folder for the full submission walkthrough.

### Bumping the version

Edit `version` in `manifest.json` and bump it on every Web Store re-upload, even for minor changes. The store rejects identical version numbers.

---

## Roadmap

Currently shipping in v0.2.0:

- Tab / Window / Screen capture
- Area-select crop
- Three duration presets
- Copy as Grid + Save PNGs (zip)
- 3-2-1 countdown, recording strip, Pause / Stop / Discard

On the deferred list:

- Custom duration + frame-rate preset (with live frame counter)
- Single-frame clipboard copy (single-thumbnail click)
- Recent-sessions cache (last 5 sessions, metadata + thumbnails)
- Persisted user preferences
- Settings panel (e.g., raise the cap to 20 frames for Claude users)

Full roadmap is in [`VideoContext_project.md`](../VideoContext_project.md#build-roadmap).

---

## License

MIT — see `LICENSE`. The macOS app in the `videocontext-mac` repo is proprietary; the two are distributed under different terms intentionally.

---

*VideoContext — built to turn screen recordings into AI-ready context, one frame at a time.*
