/**
 * content.js — VideoContext App floating recorder widget · videocontext.app
 *
 * Injected on action button click by background.js (chrome.scripting).
 * Re-injection toggles visibility, so clicking the icon twice opens/closes.
 *
 * UI layout (Loom-style):
 *   - Main control card, top-right.
 *       Source picker (Tab / Window / Screen)
 *       Select Area button + crop badge
 *       Start Recording button
 *       Frame grid + action bar (appears after a recording)
 *   - Recording strip, left edge of viewport.
 *       Vertical column with Stop / Pause / Restart / Discard / Timer.
 *   - Page dim overlay behind both panels while active.
 *   - Area-select overlay: full-viewport, draw a rect on the page.
 *
 * All UI lives in a Shadow DOM root so host-page styles can't bleed in.
 */

(() => {
  // ── 1. Toggle on re-injection ───────────────────────────────────
  if (window.__VC_WIDGET__) {
    window.__VC_WIDGET__.toggle();
    return;
  }

  // ── 2. Constants ────────────────────────────────────────────────
  const PRESETS = {
    quick:    { duration: 5,  fps: 2,   frames: 10, label: "Quick · 5s" },
    standard: { duration: 10, fps: 1,   frames: 10, label: "Standard · 10s" },
    slow:     { duration: 20, fps: 0.5, frames: 10, label: "Slow · 20s" },
  };

  const MODE_TO_SOURCES = {
    tab:    ["tab"],
    window: ["window"],
    screen: ["screen"],
  };

  // ── 3. State ────────────────────────────────────────────────────
  const state = {
    visible:   true,
    mode:      "screen",     // tab | window | screen
    preset:    "quick",
    stream:    null,
    recording: false,
    paused:    false,
    autoStopId: null,
    countdownId: null,
    captureTimerId: null,
    frames:    [],
    selected:  new Set(),
    cropRectCss: null,       // { x, y, w, h } in CSS px relative to viewport
    cropMode:    false,
    cropDragStart: null,
  };

  // ── 4. Shadow DOM host + styles ─────────────────────────────────
  const host = document.createElement("div");
  host.id = "videocontext-host";
  // Float above everything but underneath the area-select overlay we draw separately
  host.style.cssText = `
    position: fixed; top: 0; left: 0; width: 0; height: 0;
    z-index: 2147483646; pointer-events: none;
  `;
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host, * { box-sizing: border-box; }

    /* ── Main control card ─────────────────────────────────────── */
    .card {
      position: fixed; top: 18px; right: 18px;
      width: 360px;
      background: #ffffff;
      color: #1a1a22;
      border-radius: 16px;
      box-shadow: 0 12px 36px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                   Helvetica, Arial, sans-serif;
      font-size: 14px;
      line-height: 1.4;
      pointer-events: auto;
      overflow: hidden;
      max-height: calc(100vh - 36px);
      display: flex; flex-direction: column;
    }
    .card-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 14px;
      border-bottom: 1px solid #f0f0f3;
      flex-shrink: 0;
    }
    .brand { display: flex; align-items: center; gap: 9px; }
    .brand-dot {
      width: 22px; height: 22px; border-radius: 6px;
      overflow: hidden;
      display: inline-flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      background: #6C63FF;
    }
    .brand-dot img {
      width: 100%; height: 100%;
      object-fit: contain;
      display: block;
    }
    .brand-text { display: flex; flex-direction: column; line-height: 1.15; }
    .brand-name { font-weight: 600; font-size: 14px; color: #1a1a22; }
    .brand-domain {
      font-size: 11px; color: #8a8a96; text-decoration: none;
      letter-spacing: 0.1px;
    }
    .brand-domain:hover { color: #6C63FF; text-decoration: underline; }
    .close-btn {
      width: 28px; height: 28px; border-radius: 8px;
      border: none; background: transparent; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      color: #5b5b66;
      transition: background 120ms;
    }
    .close-btn:hover { background: #f3f3f6; }

    .card-body { padding: 14px; overflow-y: auto; flex: 1; min-height: 0; }
    .card-body::-webkit-scrollbar { width: 8px; }
    .card-body::-webkit-scrollbar-thumb { background: #e1e1e8; border-radius: 4px; }

    .section { margin-bottom: 14px; }
    .section:last-child { margin-bottom: 0; }
    .label { font-size: 11px; font-weight: 600; color: #6c6c78; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 6px; }

    /* Source mode pills */
    .mode-row {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;
    }
    .mode-pill {
      border: 1px solid #e6e6ec; background: #fafafd;
      border-radius: 10px;
      padding: 9px 6px 8px;
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      cursor: pointer; transition: all 120ms;
      font-size: 12px; color: #43434f;
    }
    .mode-pill:hover { background: #f3f3f8; }
    .mode-pill.active {
      background: #f1efff; border-color: #6C63FF; color: #4f47d6;
    }
    .mode-pill svg { width: 18px; height: 18px; display: block; }

    /* Preset chips */
    .preset-row {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;
    }
    .preset-chip {
      border: 1px solid #e6e6ec; background: #fafafd;
      border-radius: 8px; padding: 6px 4px;
      cursor: pointer; transition: all 120ms;
      font-size: 12px; color: #43434f;
      display: flex; flex-direction: column; align-items: center;
    }
    .preset-chip:hover { background: #f3f3f8; }
    .preset-chip.active {
      background: #f1efff; border-color: #6C63FF; color: #4f47d6; font-weight: 600;
    }
    .preset-chip small { font-size: 10px; color: #8a8a96; margin-top: 1px; }
    .preset-chip.active small { color: #6f68d6; }

    /* Area selection row */
    .area-row {
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px;
    }
    .area-btn {
      flex: 1;
      border: 1px dashed #c8c8d3; background: #fbfbff;
      border-radius: 10px; padding: 9px 12px;
      cursor: pointer; color: #43434f;
      display: inline-flex; align-items: center; gap: 8px;
      font-size: 13px;
      transition: all 120ms;
    }
    .area-btn:hover { border-color: #6C63FF; color: #4f47d6; background: #f1efff; }
    .area-btn.has-crop {
      border-style: solid; border-color: #6C63FF; background: #f1efff;
      color: #4f47d6; font-weight: 500;
    }
    .area-clear {
      border: none; background: transparent; cursor: pointer;
      color: #b5536a; font-size: 18px; padding: 4px 8px; border-radius: 6px;
    }
    .area-clear:hover { background: #fdecef; }

    /* Primary CTA */
    .cta {
      width: 100%;
      border: none; border-radius: 12px;
      background: #ff5f44; color: #fff;
      padding: 13px 16px;
      font-size: 14px; font-weight: 600;
      cursor: pointer;
      transition: background 120ms, transform 80ms;
    }
    .cta:hover { background: #ff4a2c; }
    .cta:active { transform: translateY(1px); }
    .cta[disabled] { opacity: 0.55; cursor: wait; }

    .hint {
      margin-top: 8px;
      font-size: 11px; color: #8a8a96;
      text-align: center;
    }

    /* Frame grid */
    .frames-head {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 6px;
    }
    .frames-head .label { margin-bottom: 0; }
    .link {
      background: none; border: none; cursor: pointer;
      color: #6C63FF; font-size: 12px; padding: 0;
    }
    .frames-grid {
      display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px;
      max-height: 200px; overflow-y: auto; padding: 2px;
    }
    .thumb {
      position: relative; aspect-ratio: 16/10;
      border-radius: 6px; overflow: hidden;
      border: 2px solid transparent; cursor: pointer;
      background: #f0f0f5;
    }
    .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .thumb.selected { border-color: #6C63FF; }
    .thumb .num {
      position: absolute; top: 2px; left: 2px;
      background: rgba(0,0,0,0.55); color: #fff;
      font-size: 9px; padding: 1px 4px; border-radius: 4px;
    }
    .thumb.selected::after {
      content: "✓"; position: absolute; top: 2px; right: 2px;
      background: #6C63FF; color: #fff;
      width: 14px; height: 14px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px;
    }

    .actions { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; margin-top: 8px; }
    .actions .full { grid-column: 1 / -1; }
    .action-btn {
      border: 1px solid #e0e0e8; background: #fff; color: #1a1a22;
      border-radius: 10px; padding: 9px 10px;
      font-size: 12px; font-weight: 500; cursor: pointer;
      transition: all 120ms;
    }
    .action-btn:hover { background: #f7f7fb; border-color: #c8c8d3; }
    .action-btn.primary {
      background: #6C63FF; border-color: #6C63FF; color: #fff;
    }
    .action-btn.primary:hover { background: #5a52e0; }
    .action-btn.danger { color: #c0392b; }
    .action-btn.danger:hover { background: #fdecea; border-color: #f5c6c0; }

    .warn {
      background: #fff8db; border: 1px solid #ffe27a;
      color: #7d6207;
      border-radius: 8px;
      padding: 8px 10px; font-size: 12px;
      margin-top: 8px;
    }

    /* Toast */
    .toast {
      position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%);
      background: #1a1a22; color: #fff;
      padding: 10px 16px; border-radius: 10px;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 13px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.25);
      pointer-events: none;
      opacity: 0; transition: opacity 180ms;
      z-index: 2147483647;
    }
    .toast.show { opacity: 1; }
    .toast.error { background: #c0392b; }
    .toast.success { background: #2c8a4a; }

    /* ── Recording strip (left side, vertical) ─────────────────── */
    .strip {
      position: fixed; left: 18px; top: 50%; transform: translateY(-50%);
      width: 56px;
      background: #1a1a22; color: #fff;
      border-radius: 14px;
      padding: 8px 0;
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
      pointer-events: auto;
    }
    .strip-btn {
      width: 42px; height: 42px; border-radius: 10px;
      border: none; background: transparent; color: #fff;
      cursor: pointer; transition: background 120ms;
      display: flex; align-items: center; justify-content: center;
    }
    .strip-btn:hover { background: rgba(255,255,255,0.1); }
    .strip-btn.stop { background: #ff5f44; }
    .strip-btn.stop:hover { background: #ff4a2c; }

    /* ── 3-2-1 countdown ───────────────────────────────────────── */
    .countdown {
      position: fixed; inset: 0;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 26px;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                   Helvetica, Arial, sans-serif;
    }
    .cd-row {
      display: flex; align-items: center; gap: 30px;
      pointer-events: auto;
    }
    .cd-circle {
      width: 180px; height: 180px;
      border-radius: 50%;
      background: #3a72ff;
      color: #fff;
      font-size: 110px; font-weight: 600; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 14px 50px rgba(58,114,255,0.45),
                  0 0 0 8px rgba(58,114,255,0.18);
      user-select: none;
    }
    .cd-side {
      width: 88px; height: 88px;
      border-radius: 50%;
      background: rgba(0,0,0,0.55);
      border: 2px solid rgba(255,255,255,0.7);
      color: #fff;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: background 120ms, transform 80ms;
    }
    .cd-side:hover  { background: rgba(0,0,0,0.75); }
    .cd-side:active { transform: scale(0.94); }
    .cd-hint {
      background: rgba(0,0,0,0.75);
      color: #fff;
      padding: 8px 14px;
      border-radius: 999px;
      font-size: 13px;
      pointer-events: none;
    }

    /* ── Area-select overlay ───────────────────────────────────── */
    .area-overlay {
      position: fixed; inset: 0;
      cursor: crosshair;
      pointer-events: auto;
      background: rgba(20,20,26,0.32);
    }
    .area-overlay canvas {
      position: absolute; inset: 0; width: 100%; height: 100%;
      pointer-events: none;
    }
    .area-hint {
      position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
      background: #1a1a22; color: #fff;
      padding: 8px 14px; border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 13px;
      pointer-events: none;
      box-shadow: 0 6px 18px rgba(0,0,0,0.3);
    }

    .hidden { display: none !important; }
  `;
  shadow.appendChild(style);

  // ── 5. UI templates ─────────────────────────────────────────────
  const root = document.createElement("div");
  root.innerHTML = `
    <!-- 3-2-1 countdown (between stream acquired and frame capture) -->
    <div class="countdown hidden" id="countdown">
      <div class="cd-row">
        <button class="cd-side" id="btn-cd-cancel" title="Cancel">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
            <path d="M8 8l16 16M24 8L8 24"/>
          </svg>
        </button>
        <div class="cd-circle" id="cd-num">3</div>
        <button class="cd-side" id="btn-cd-skip" title="Skip to recording">
          <svg width="30" height="30" viewBox="0 0 30 30" fill="currentColor">
            <polygon points="8,6 20,15 8,24"/>
            <rect x="21" y="6" width="3" height="18" rx="1"/>
          </svg>
        </button>
      </div>
      <div class="cd-hint">Press Esc to cancel</div>
    </div>

    <!-- Area select layer -->
    <div class="area-overlay hidden" id="area-overlay">
      <canvas id="area-canvas"></canvas>
    </div>
    <div class="area-hint hidden" id="area-hint">Drag to select an area · Esc to cancel</div>

    <!-- Recording strip (shown only while recording) -->
    <div class="strip hidden" id="strip">
      <button class="strip-btn stop" id="btn-stop" title="Stop recording">
        <svg width="14" height="14" viewBox="0 0 14 14"><rect width="14" height="14" rx="2" fill="currentColor"/></svg>
      </button>
      <button class="strip-btn" id="btn-pause" title="Pause / resume">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="2" y="2" width="3" height="10" rx="1"/><rect x="9" y="2" width="3" height="10" rx="1"/></svg>
      </button>
      <button class="strip-btn" id="btn-discard" title="Discard">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 4h9M5 4V2.5h4V4M4 4l.5 8a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1L10 4"/></svg>
      </button>
    </div>

    <!-- Main control card -->
    <div class="card" id="card">
      <div class="card-header">
        <div class="brand">
          <span class="brand-dot">
            <img src="${chrome.runtime.getURL("assets/logo.png")}" alt="" />
          </span>
          <div class="brand-text">
            <span class="brand-name">VideoContext App</span>
            <a class="brand-domain" href="https://videocontext.app" target="_blank" rel="noopener">videocontext.app</a>
          </div>
        </div>
        <button class="close-btn" id="btn-close" title="Close">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 3l8 8M11 3l-8 8"/></svg>
        </button>
      </div>

      <div class="card-body" id="body">
        <!-- Source mode -->
        <div class="section">
          <div class="label">Capture</div>
          <div class="mode-row">
            <button class="mode-pill" data-mode="tab">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="4" width="15" height="12" rx="1.5"/><path d="M2.5 7.5h15"/></svg>
              Tab
            </button>
            <button class="mode-pill" data-mode="window">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="14" height="14" rx="1.5"/><path d="M3 7h14"/></svg>
              Window
            </button>
            <button class="mode-pill active" data-mode="screen">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="4" width="16" height="11" rx="1.5"/><path d="M7 18h6"/></svg>
              Screen
            </button>
          </div>
        </div>

        <!-- Preset -->
        <div class="section">
          <div class="label">Duration</div>
          <div class="preset-row">
            <button class="preset-chip active" data-preset="quick">Quick<small>5s · 10f</small></button>
            <button class="preset-chip" data-preset="standard">Standard<small>10s · 10f</small></button>
            <button class="preset-chip" data-preset="slow">Slow<small>20s · 10f</small></button>
          </div>
        </div>

        <!-- Area selection -->
        <div class="section">
          <div class="label">Area</div>
          <div class="area-row">
            <button class="area-btn" id="btn-area">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4">
                <path d="M2 2h3M9 2h3M2 12h3M9 12h3M2 5V2M2 9v3M12 5V2M12 9v3"/>
              </svg>
              <span id="area-label">Select area</span>
            </button>
            <button class="area-clear hidden" id="btn-area-clear" title="Clear">✕</button>
          </div>
          <div class="hint" id="area-hint-text">Optional. Crops every captured frame.</div>
        </div>

        <!-- CTA -->
        <div class="section">
          <button class="cta" id="btn-record">Start Recording</button>
          <div class="hint">Up to 10 frames · pastes into any LLM</div>
        </div>

        <!-- Frames + actions (post-recording) -->
        <div class="section hidden" id="frames-section">
          <div class="frames-head">
            <div class="label" id="frames-count-label">Frames</div>
            <button class="link" id="btn-select-all">Select all</button>
          </div>
          <div class="frames-grid" id="frames-grid"></div>
          <div class="warn hidden" id="frames-warn">
            ⚠ Over 10 frames — ChatGPT &amp; Gemini cap at 10. Use Copy as Grid.
          </div>
          <div class="actions">
            <button class="action-btn primary full" id="btn-copy-grid">Copy as Grid ★</button>
            <button class="action-btn full" id="btn-save">Save PNGs (zip)</button>
            <button class="action-btn danger full" id="btn-clear">Clear &amp; restart</button>
          </div>
        </div>
      </div>
    </div>

    <div class="toast" id="toast"></div>
  `;
  shadow.appendChild(root);

  // ── 6. DOM refs ────────────────────────────────────────────────
  const $ = (id) => shadow.getElementById(id);
  const els = {
    card:          $("card"),
    strip:         $("strip"),
    btnStop:       $("btn-stop"),
    btnPause:      $("btn-pause"),
    btnDiscard:    $("btn-discard"),
    btnClose:      $("btn-close"),
    modeBtns:      shadow.querySelectorAll(".mode-pill"),
    presetBtns:    shadow.querySelectorAll(".preset-chip"),
    btnArea:       $("btn-area"),
    btnAreaClear:  $("btn-area-clear"),
    areaLabel:     $("area-label"),
    btnRecord:     $("btn-record"),
    framesSection: $("frames-section"),
    framesGrid:    $("frames-grid"),
    framesWarn:    $("frames-warn"),
    framesCountLabel: $("frames-count-label"),
    btnSelectAll: $("btn-select-all"),
    btnCopyGrid:  $("btn-copy-grid"),
    btnSave:      $("btn-save"),
    btnClear:     $("btn-clear"),
    areaOverlay:  $("area-overlay"),
    areaCanvas:   $("area-canvas"),
    areaHint:     $("area-hint"),
    countdown:    $("countdown"),
    cdNum:        $("cd-num"),
    btnCdCancel:  $("btn-cd-cancel"),
    btnCdSkip:    $("btn-cd-skip"),
    toast:        $("toast"),
  };

  // Hidden video + canvas live OUTSIDE shadow root because the desktop stream
  // attaches to a real HTMLVideoElement and we want it to render off-screen.
  const hiddenVideo = document.createElement("video");
  hiddenVideo.muted = true;
  hiddenVideo.autoplay = true;
  hiddenVideo.playsInline = true;
  hiddenVideo.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;";
  document.documentElement.appendChild(hiddenVideo);

  const captureCanvas = document.createElement("canvas");

  // ── 7. Background port ─────────────────────────────────────────
  let port = null;
  function connectPort() {
    port = chrome.runtime.connect({ name: "vc-widget" });
    port.onMessage.addListener((msg) => {
      switch (msg.action) {
        case "STREAM_ID":         setupStream(msg.streamId); break;
        case "CAPTURE_CANCELLED": resetRecordButton(); break;
        case "CAPTURE_ERROR":     showToast(msg.error || "Capture failed", "error"); resetRecordButton(); break;
      }
    });
    port.onDisconnect.addListener(() => { port = null; });
  }
  connectPort();

  // ── 8. Mode + preset buttons ───────────────────────────────────
  els.modeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      state.mode = btn.dataset.mode;
      els.modeBtns.forEach((b) => b.classList.toggle("active", b === btn));
    });
  });

  els.presetBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      state.preset = btn.dataset.preset;
      els.presetBtns.forEach((b) => b.classList.toggle("active", b === btn));
    });
  });

  // ── 9. Area selection ──────────────────────────────────────────
  els.btnArea.addEventListener("click", enterAreaMode);
  els.btnAreaClear.addEventListener("click", clearArea);

  function enterAreaMode() {
    state.cropMode = true;
    state.cropDragStart = null;
    sizeAreaCanvas();
    els.areaOverlay.classList.remove("hidden");
    els.areaHint.classList.remove("hidden");
    els.card.style.opacity = "0.25";
    els.card.style.pointerEvents = "none";
  }

  function exitAreaMode() {
    state.cropMode = false;
    state.cropDragStart = null;
    els.areaOverlay.classList.add("hidden");
    els.areaHint.classList.add("hidden");
    els.card.style.opacity = "";
    els.card.style.pointerEvents = "";
  }

  function sizeAreaCanvas() {
    const c = els.areaCanvas;
    c.width  = window.innerWidth;
    c.height = window.innerHeight;
  }

  els.areaOverlay.addEventListener("mousedown", (e) => {
    if (!state.cropMode) return;
    state.cropDragStart = { x: e.clientX, y: e.clientY };
  });

  els.areaOverlay.addEventListener("mousemove", (e) => {
    if (!state.cropMode || !state.cropDragStart) return;
    drawRubberband(state.cropDragStart, { x: e.clientX, y: e.clientY });
  });

  els.areaOverlay.addEventListener("mouseup", (e) => finishAreaDrag(e));
  els.areaOverlay.addEventListener("mouseleave", (e) => finishAreaDrag(e));

  function finishAreaDrag(e) {
    if (!state.cropMode || !state.cropDragStart) return;
    const end = { x: e.clientX, y: e.clientY };
    const x = Math.min(state.cropDragStart.x, end.x);
    const y = Math.min(state.cropDragStart.y, end.y);
    const w = Math.abs(end.x - state.cropDragStart.x);
    const h = Math.abs(end.y - state.cropDragStart.y);

    if (w < 8 || h < 8) {
      exitAreaMode();
      return;
    }

    state.cropRectCss = { x, y, w, h };
    els.areaLabel.textContent = `Area: ${Math.round(w)} × ${Math.round(h)} px`;
    els.btnArea.classList.add("has-crop");
    els.btnAreaClear.classList.remove("hidden");
    exitAreaMode();
  }

  function clearArea() {
    state.cropRectCss = null;
    els.areaLabel.textContent = "Select area";
    els.btnArea.classList.remove("has-crop");
    els.btnAreaClear.classList.add("hidden");
  }

  function drawRubberband(a, b) {
    const ctx = els.areaCanvas.getContext("2d");
    const W = els.areaCanvas.width, H = els.areaCanvas.height;
    ctx.clearRect(0, 0, W, H);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    ctx.fillStyle = "rgba(20,20,26,0.45)";
    ctx.fillRect(0, 0, W, H);
    ctx.clearRect(x, y, w, h);
    ctx.strokeStyle = "#6C63FF";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
  }

  // Esc cancels either area-select or the countdown
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (state.cropMode) {
      exitAreaMode();
    } else if (state.countdownId) {
      cancelCountdown();
    }
  });

  window.addEventListener("resize", () => {
    if (state.cropMode) sizeAreaCanvas();
  });

  // ── 10. Recording flow ─────────────────────────────────────────
  els.btnRecord.addEventListener("click", () => {
    if (state.recording) return;
    startRecording();
  });

  els.btnStop.addEventListener("click", () => stopRecording(false));
  els.btnDiscard.addEventListener("click", () => {
    stopRecording(false);
    state.frames.forEach((f) => URL.revokeObjectURL(f.url));
    state.frames = [];
    state.selected = new Set();
    els.framesGrid.innerHTML = "";
    els.framesSection.classList.add("hidden");
  });
  els.btnPause.addEventListener("click", togglePause);
  els.btnClose.addEventListener("click", destroyWidget);

  function startRecording() {
    els.btnRecord.disabled = true;
    els.btnRecord.textContent = "Opening picker…";
    if (!port) connectPort();
    // Pass which sources Chrome's picker should offer
    port.postMessage({ action: "START_CAPTURE", sources: MODE_TO_SOURCES[state.mode] });
  }

  async function setupStream(streamId) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource:   "desktop",
            chromeMediaSourceId: streamId,
          },
        },
      });
      state.stream = stream;
      hiddenVideo.srcObject = stream;
      await hiddenVideo.play().catch(() => {});

      // Wait for metadata before computing crop
      if (hiddenVideo.readyState < 1) {
        await new Promise((res) => hiddenVideo.addEventListener("loadedmetadata", res, { once: true }));
      }

      startCountdown();
    } catch (err) {
      console.error("getUserMedia error:", err);
      showToast("Could not start capture: " + (err.message || err.name), "error");
      resetRecordButton();
    }
  }

  // ── Countdown (3-2-1) before recording ─────────────────────────
  //
  // The countdown sits between stream-acquisition and frame-capture. It
  // serves two purposes:
  //   1. Gives the user a moment to ready the page they're capturing.
  //   2. By the time it ends, Chrome's focus on the picker UI has fully
  //      released, so keyboard input reaches the page without a tap.

  function startCountdown() {
    // Hide the card; show the countdown overlay
    els.card.classList.add("hidden");
    els.countdown.classList.remove("hidden");
    let n = 3;
    paintCountdown(n);
    returnFocusToPage();

    state.countdownId = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearInterval(state.countdownId);
        state.countdownId = null;
        els.countdown.classList.add("hidden");
        beginCapture();
        return;
      }
      paintCountdown(n);
    }, 1000);

    els.btnCdCancel.onclick = cancelCountdown;
    els.btnCdSkip.onclick   = skipCountdown;
  }

  function paintCountdown(n) {
    els.cdNum.textContent = String(n);
    // Re-trigger pop animation on each digit
    els.cdNum.animate(
      [
        { transform: "scale(0.7)", opacity: 0.2 },
        { transform: "scale(1.08)", opacity: 1, offset: 0.6 },
        { transform: "scale(1)",   opacity: 1 },
      ],
      { duration: 420, easing: "cubic-bezier(.2,.9,.3,1)" }
    );
  }

  function cancelCountdown() {
    if (state.countdownId) { clearInterval(state.countdownId); state.countdownId = null; }
    els.countdown.classList.add("hidden");
    els.card.classList.remove("hidden");
    // Stop the already-acquired stream — the user changed their mind
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
      hiddenVideo.srcObject = null;
    }
    resetRecordButton();
  }

  function skipCountdown() {
    if (state.countdownId) { clearInterval(state.countdownId); state.countdownId = null; }
    els.countdown.classList.add("hidden");
    beginCapture();
  }

  /**
   * Aggressively push keyboard focus back to the page. Used at countdown
   * start so the page is fully focused by the time recording begins.
   *
   *   1. Defer to next tick so DOM transitions settle.
   *   2. Blur whatever is focused inside the shadow root.
   *   3. Briefly mark <body> tabindex="-1" and focus it, then restore.
   */
  function returnFocusToPage() {
    setTimeout(() => {
      try {
        const a = shadow.activeElement;
        if (a && typeof a.blur === "function") a.blur();

        const body = document.body;
        if (body) {
          const had = body.hasAttribute("tabindex");
          const prev = body.getAttribute("tabindex");
          body.setAttribute("tabindex", "-1");
          body.focus({ preventScroll: true });
          if (had) body.setAttribute("tabindex", prev);
          else     body.removeAttribute("tabindex");
        }
        window.focus();
      } catch (_) { /* best-effort */ }
    }, 0);
  }

  function beginCapture() {
    state.recording = true;
    state.paused    = false;
    state.frames    = [];
    state.selected  = new Set();
    els.framesGrid.innerHTML = "";
    els.framesSection.classList.add("hidden");

    const preset = PRESETS[state.preset];

    // Loom-style: hide the full control card while recording. Only the side
    // strip stays visible so the page is unobscured.
    els.strip.classList.remove("hidden");
    els.btnRecord.classList.add("hidden");
    els.card.classList.add("hidden");

    // Auto-stop after the preset duration. No visible countdown — duration
    // is fixed and known up-front; an in-strip ticker added noise.
    state.autoStopId = setTimeout(() => stopRecording(true), preset.duration * 1000);

    // Resolve crop rect in *video pixels* using the stream's actual dimensions
    const cropVideoRect = resolveCropForStream();

    // Capture frames on interval
    const intervalMs = Math.round(1000 / preset.fps);
    state.captureTimerId = setInterval(() => {
      if (state.paused) return;
      captureFrame(cropVideoRect);
      if (state.frames.length >= preset.frames) {
        stopRecording(true);
      }
    }, intervalMs);
  }

  function captureFrame(cropVideoRect) {
    if (!hiddenVideo.videoWidth) return;

    const vw = hiddenVideo.videoWidth;
    const vh = hiddenVideo.videoHeight;

    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (cropVideoRect) {
      sx = Math.max(0, Math.min(vw - 1, cropVideoRect.x));
      sy = Math.max(0, Math.min(vh - 1, cropVideoRect.y));
      sw = Math.max(1, Math.min(vw - sx, cropVideoRect.w));
      sh = Math.max(1, Math.min(vh - sy, cropVideoRect.h));
    }
    captureCanvas.width  = sw;
    captureCanvas.height = sh;
    const ctx = captureCanvas.getContext("2d");
    ctx.drawImage(hiddenVideo, sx, sy, sw, sh, 0, 0, sw, sh);

    captureCanvas.toBlob((blob) => {
      if (!blob) return;
      const idx = state.frames.length;
      const url = URL.createObjectURL(blob);
      const frame = { blob, url, index: idx };
      state.frames.push(frame);
      state.selected.add(idx);
      addThumb(frame);
      updateFrameWarn();
      els.framesSection.classList.remove("hidden");
    }, "image/png");
  }

  /**
   * Map the user-drawn viewport CSS rect into video pixel coordinates,
   * which depend on what they're capturing (tab vs screen vs window).
   *
   *   Tab    : video is the tab content area, mapped via viewport ratio.
   *   Screen : video is the full physical screen; rect translated by
   *            window.screen offset + devicePixelRatio.
   *   Window : we don't know the captured window's screen rect, so we
   *            apply the viewport ratio as a best effort.
   */
  function resolveCropForStream() {
    if (!state.cropRectCss) return null;
    const vw = hiddenVideo.videoWidth, vh = hiddenVideo.videoHeight;
    if (!vw || !vh) return null;
    const r = state.cropRectCss;

    if (state.mode === "tab" || state.mode === "window") {
      const sx = vw / window.innerWidth;
      const sy = vh / window.innerHeight;
      return { x: Math.round(r.x * sx), y: Math.round(r.y * sy),
               w: Math.round(r.w * sx), h: Math.round(r.h * sy) };
    }

    // screen mode
    const screenW = window.screen.width;
    const screenH = window.screen.height;
    const viewportLeftCss = window.screenX;
    const viewportTopCss  = window.screenY + (window.outerHeight - window.innerHeight);
    const sx = vw / screenW;
    const sy = vh / screenH;
    return {
      x: Math.round((viewportLeftCss + r.x) * sx),
      y: Math.round((viewportTopCss  + r.y) * sy),
      w: Math.round(r.w * sx),
      h: Math.round(r.h * sy),
    };
  }

  function togglePause() {
    if (!state.recording) return;
    state.paused = !state.paused;
    // Swap the pause/resume icon
    const svg = state.paused
      ? `<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><polygon points="3,2 12,7 3,12"/></svg>`
      : `<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="2" y="2" width="3" height="10" rx="1"/><rect x="9" y="2" width="3" height="10" rx="1"/></svg>`;
    els.btnPause.innerHTML = svg;
  }

  function stopRecording(autoStopped) {
    if (state.captureTimerId) { clearInterval(state.captureTimerId); state.captureTimerId = null; }
    if (state.autoStopId)     { clearTimeout(state.autoStopId);      state.autoStopId = null; }

    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
      hiddenVideo.srcObject = null;
    }
    state.recording = false;
    state.paused    = false;

    els.strip.classList.add("hidden");
    els.card.classList.remove("hidden");
    els.btnRecord.classList.remove("hidden");
    resetRecordButton();

    if (state.frames.length > 0) {
      els.framesSection.classList.remove("hidden");
      renderSelectAllLabel();
      updateFrameWarn();
    }
    if (autoStopped) showToast("Recording complete ✓", "success");
  }

  function resetRecordButton() {
    els.btnRecord.disabled = false;
    els.btnRecord.textContent = "Start Recording";
  }

  // ── 11. Frame thumbnails ────────────────────────────────────────
  function addThumb(frame) {
    const t = document.createElement("div");
    t.className = "thumb selected";
    t.dataset.idx = frame.index;
    const img = document.createElement("img");
    img.src = frame.url;
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = frame.index + 1;
    t.append(img, num);
    t.addEventListener("click", () => toggleThumb(frame.index, t));
    els.framesGrid.appendChild(t);
    els.framesCountLabel.textContent = `Frames · ${state.frames.length}`;
  }

  function toggleThumb(idx, el) {
    if (state.selected.has(idx)) { state.selected.delete(idx); el.classList.remove("selected"); }
    else                          { state.selected.add(idx);   el.classList.add("selected");   }
    renderSelectAllLabel();
  }

  function renderSelectAllLabel() {
    const all = state.selected.size === state.frames.length;
    els.btnSelectAll.textContent = all ? "Deselect all" : "Select all";
  }

  function updateFrameWarn() {
    els.framesWarn.classList.toggle("hidden", state.frames.length <= 10);
  }

  els.btnSelectAll.addEventListener("click", () => {
    const all = state.selected.size === state.frames.length;
    state.selected.clear();
    shadow.querySelectorAll(".thumb").forEach((t) => {
      const idx = parseInt(t.dataset.idx, 10);
      if (!all) { state.selected.add(idx); t.classList.add("selected"); }
      else      { t.classList.remove("selected"); }
    });
    renderSelectAllLabel();
  });

  // ── 12. Clipboard / save ───────────────────────────────────────
  els.btnCopyGrid.addEventListener("click", onCopyGrid);
  els.btnSave.addEventListener("click", onSave);
  els.btnClear.addEventListener("click", () => {
    state.frames.forEach((f) => URL.revokeObjectURL(f.url));
    state.frames = [];
    state.selected = new Set();
    els.framesGrid.innerHTML = "";
    els.framesSection.classList.add("hidden");
  });

  function getSelectedFrames() {
    return state.frames.filter((f) => state.selected.has(f.index));
  }

  async function onCopyGrid() {
    const frames = getSelectedFrames();
    if (!frames.length) return showToast("Select at least one frame", "error");
    els.btnCopyGrid.disabled = true; els.btnCopyGrid.textContent = "Stitching…";
    try {
      const imgs = await loadImages(frames.map((f) => f.url));
      const canvas = buildCollage(imgs);
      const blob = await canvasToBlob(canvas);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      showToast(`Copied ${frames.length}-frame grid`, "success");
    } catch (e) {
      console.error(e);
      showToast("Copy failed: " + e.message, "error");
    }
    els.btnCopyGrid.disabled = false; els.btnCopyGrid.textContent = "Copy as Grid ★";
  }

  async function onSave() {
    const frames = getSelectedFrames();
    if (!frames.length) return showToast("Select at least one frame", "error");
    els.btnSave.disabled = true;
    const originalLabel = els.btnSave.textContent;
    els.btnSave.textContent = "Zipping…";
    try {
      const entries = frames.map((f) => ({
        name: `frame-${String(f.index + 1).padStart(3, "0")}.png`,
        blob: f.blob,
      }));
      const zipBlob = await createZip(entries);
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      triggerDownload(zipBlob, `videocontext-${ts}.zip`);
      showToast(`Saved ${frames.length} frame(s) as zip`, "success");
    } catch (e) {
      console.error(e);
      showToast("Save failed: " + e.message, "error");
    }
    els.btnSave.disabled = false;
    els.btnSave.textContent = originalLabel;
  }

  // ── Minimal in-browser ZIP writer (stored mode, no compression) ──
  // PNGs are already DEFLATE-compressed internally, so storing them in
  // an uncompressed zip costs almost nothing. This avoids bundling a
  // 90KB library like JSZip just for a stored archive.

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  async function createZip(files) {
    const now = new Date();
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >>> 1);

    const chunks  = [];
    const entries = [];
    let offset    = 0;

    for (const f of files) {
      const data      = new Uint8Array(await f.blob.arrayBuffer());
      const nameBytes = new TextEncoder().encode(f.name);
      const crc       = crc32(data);

      const header = new ArrayBuffer(30 + nameBytes.length);
      const hv     = new DataView(header);
      hv.setUint32(0,  0x04034b50, true);
      hv.setUint16(4,  20, true);
      hv.setUint16(6,  0, true);
      hv.setUint16(8,  0, true);              // method: store
      hv.setUint16(10, dosTime, true);
      hv.setUint16(12, dosDate, true);
      hv.setUint32(14, crc, true);
      hv.setUint32(18, data.length, true);    // compressed size
      hv.setUint32(22, data.length, true);    // uncompressed size
      hv.setUint16(26, nameBytes.length, true);
      hv.setUint16(28, 0, true);
      new Uint8Array(header, 30).set(nameBytes);

      chunks.push(header, data);
      entries.push({ nameBytes, crc, size: data.length, offset });
      offset += header.byteLength + data.length;
    }

    const cdStart = offset;
    let cdSize    = 0;

    for (const e of entries) {
      const cd = new ArrayBuffer(46 + e.nameBytes.length);
      const dv = new DataView(cd);
      dv.setUint32(0,  0x02014b50, true);
      dv.setUint16(4,  20, true);
      dv.setUint16(6,  20, true);
      dv.setUint16(8,  0, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, dosTime, true);
      dv.setUint16(14, dosDate, true);
      dv.setUint32(16, e.crc, true);
      dv.setUint32(20, e.size, true);
      dv.setUint32(24, e.size, true);
      dv.setUint16(28, e.nameBytes.length, true);
      dv.setUint16(30, 0, true);
      dv.setUint16(32, 0, true);
      dv.setUint16(34, 0, true);
      dv.setUint16(36, 0, true);
      dv.setUint32(38, 0, true);
      dv.setUint32(42, e.offset, true);
      new Uint8Array(cd, 46).set(e.nameBytes);

      chunks.push(cd);
      cdSize += cd.byteLength;
    }

    const eocd  = new ArrayBuffer(22);
    const ev    = new DataView(eocd);
    ev.setUint32(0,  0x06054b50, true);
    ev.setUint16(4,  0, true);
    ev.setUint16(6,  0, true);
    ev.setUint16(8,  entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    ev.setUint16(20, 0, true);
    chunks.push(eocd);

    return new Blob(chunks, { type: "application/zip" });
  }

  function loadImages(urls) {
    return Promise.all(urls.map((url) => new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("Image load failed"));
      img.src = url;
    })));
  }

  function buildCollage(images) {
    const gap = 4;
    const n = images.length;
    const { cols, rows } = autoLayout(n);
    const cellW = images[0].naturalWidth;
    const cellH = images[0].naturalHeight;

    // Footer strip for the videocontext.app watermark. Size proportional to
    // cell height so it reads on tiny tab caps and full Retina screens alike.
    // Clamped so a 240×135 thumbnail doesn't get a 6px footer and a 2880×1800
    // capture doesn't get a 120px slab.
    const watermarkH = Math.max(28, Math.min(64, Math.round(cellH * 0.045)));
    const fontPx     = Math.round(watermarkH * 0.55);

    const c = document.createElement("canvas");
    c.width  = cols * cellW + (cols - 1) * gap;
    c.height = rows * cellH + (rows - 1) * gap + watermarkH;

    const ctx = c.getContext("2d");
    ctx.fillStyle = "#1a1a22";
    ctx.fillRect(0, 0, c.width, c.height);

    images.forEach((img, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      ctx.drawImage(img, col * (cellW + gap), row * (cellH + gap), cellW, cellH);
    });

    // Watermark — right-aligned, muted white. Captures the project domain so
    // anyone (and any LLM) seeing the grid knows where it came from.
    ctx.fillStyle    = "rgba(255,255,255,0.55)";
    ctx.font         = `500 ${fontPx}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
    ctx.textAlign    = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(
      "videocontext.app",
      c.width - Math.round(watermarkH * 0.6),
      c.height - watermarkH / 2
    );

    return c;
  }

  function autoLayout(n) {
    if (n <= 1)  return { cols: 1, rows: 1 };
    if (n <= 2)  return { cols: 2, rows: 1 };
    if (n <= 3)  return { cols: 3, rows: 1 };
    if (n <= 4)  return { cols: 2, rows: 2 };
    if (n <= 6)  return { cols: 3, rows: 2 };
    if (n <= 8)  return { cols: 4, rows: 2 };
    if (n <= 10) return { cols: 5, rows: 2 };
    if (n <= 12) return { cols: 4, rows: 3 };
    if (n <= 16) return { cols: 4, rows: 4 };
    return { cols: 5, rows: Math.ceil(n / 5) };
  }

  function canvasToBlob(c) {
    return new Promise((res, rej) => {
      c.toBlob((b) => b ? res(b) : rej(new Error("toBlob failed")), "image/png");
    });
  }

  function triggerDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── 13. Toast ──────────────────────────────────────────────────
  let toastTimer = null;
  function showToast(msg, kind = "") {
    els.toast.textContent = msg;
    els.toast.className = `toast show ${kind}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.remove("show");
    }, 2600);
  }

  // ── 14. Toggle / destroy ───────────────────────────────────────
  function toggle() {
    state.visible = !state.visible;
    host.style.display = state.visible ? "" : "none";
  }

  function destroyWidget() {
    if (state.countdownId) cancelCountdown();
    if (state.recording) stopRecording(false);
    state.frames.forEach((f) => URL.revokeObjectURL(f.url));
    try { port && port.disconnect(); } catch (_) {}
    host.remove();
    hiddenVideo.remove();
    delete window.__VC_WIDGET__;
  }

  // ── 16. Expose sentinel ────────────────────────────────────────
  window.__VC_WIDGET__ = { toggle, destroy: destroyWidget };
})();
