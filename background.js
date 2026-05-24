/**
 * background.js — VideoContext Service Worker
 *
 * Architecture:
 *   Click toolbar icon → inject content.js into active tab → widget appears.
 *   The content script holds the live stream, frame extractor, clipboard ops,
 *   and the whole floating UI (Shadow DOM).
 *
 *   The service worker only does two things:
 *     1. Inject the content script on action click.
 *     2. Open the chrome.desktopCapture screen picker on request and route
 *        the resulting streamId back to the content script.
 *
 * Why the content-script lives on the page:
 *   - Survives picker focus loss (no MV3 popup auto-close).
 *   - Lets the user draw an area-select region directly on the page.
 *   - Lets us render a floating control bar overlaid on the page DOM.
 *
 * Port protocol:
 *   content.js opens:  chrome.runtime.connect({ name: "vc-widget" })
 *
 *   widget → background (port.postMessage):
 *     { action: "START_CAPTURE" }
 *
 *   background → widget (port.postMessage):
 *     { action: "STREAM_ID",         streamId: "<id>" }
 *     { action: "CAPTURE_CANCELLED"                   }
 *     { action: "CAPTURE_ERROR",     error: "<msg>"   }
 */

const RESTRICTED_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "chrome-search://",
  "chrome-devtools://",
  "devtools://",
  "edge://",
  "about:",
  "view-source:",
  "https://chromewebstore.google.com",
  "https://chrome.google.com/webstore",
];

function isInjectable(url) {
  if (!url) return false;
  return !RESTRICTED_PREFIXES.some((p) => url.startsWith(p));
}

// ── Action button → inject the content-script widget ──────────────
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || typeof tab.id !== "number") return;

  if (!isInjectable(tab.url)) {
    // Open an info notification — content scripts can't inject into chrome://
    // pages and similar. Best we can do is alert the user.
    chrome.action.setBadgeText({ text: "✕", tabId: tab.id });
    chrome.action.setBadgeBackgroundColor({ color: "#ff5f44", tabId: tab.id });
    setTimeout(() => chrome.action.setBadgeText({ text: "", tabId: tab.id }), 2500);
    return;
  }

  try {
    // The widget script checks for a sentinel global and toggles on re-injection,
    // so clicking the icon twice opens/closes the panel.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files:  ["content.js"],
    });
  } catch (e) {
    console.error("VideoContext injection failed:", e);
  }
});

// ── Port from content-script widget ───────────────────────────────
const ports = new Map(); // tabId → port

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "vc-widget") return;

  const tabId = port.sender && port.sender.tab && port.sender.tab.id;
  if (typeof tabId === "number") ports.set(tabId, port);

  port.onMessage.addListener((msg) => handleMessage(msg, port));
  port.onDisconnect.addListener(() => {
    if (typeof tabId === "number") ports.delete(tabId);
  });
});

function handleMessage(message, port) {
  if (message.action !== "START_CAPTURE") return;

  // Respect the source filter the widget asked for. Chrome's picker will show
  // only the tab(s) we pass — e.g., ["tab"] hides "Entire Screen" and "Window".
  // Fall back to all three if the message didn't specify.
  const ALL = ["screen", "window", "tab"];
  const sources = Array.isArray(message.sources) && message.sources.length
    ? message.sources.filter((s) => ALL.includes(s))
    : ALL;
  const targetTab = port.sender && port.sender.tab;

  if (!targetTab || typeof targetTab.id !== "number") {
    reply(port, { action: "CAPTURE_ERROR", error: "Recorder tab not available." });
    return;
  }

  try {
    chrome.desktopCapture.chooseDesktopMedia(sources, targetTab, (streamId, opts) => {
      if (chrome.runtime.lastError) {
        reply(port, { action: "CAPTURE_ERROR", error: chrome.runtime.lastError.message });
        return;
      }
      if (!streamId) {
        reply(port, { action: "CAPTURE_CANCELLED" });
        return;
      }
      // opts.canRequestAudioTrack would tell us whether system audio is available;
      // we don't capture audio in v0.2, so we ignore it.
      reply(port, { action: "STREAM_ID", streamId });
    });
  } catch (e) {
    reply(port, { action: "CAPTURE_ERROR", error: e.message || String(e) });
  }
}

function reply(port, message) {
  try { port.postMessage(message); }
  catch (e) { console.warn("VideoContext: could not reach widget:", e.message); }
}
