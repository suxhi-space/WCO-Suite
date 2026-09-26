/* =================================================================
   WCO Suite – popout-player.js v22

   Builds the SAME real #wcp player used on the site (identical CSS/
   markup, copied from the embed player so they're visually and
   functionally identical) inside this standalone extension page.

   This page's OWN document never navigates — episodes are handled by
   swapping the <video> src via sync messages from the source tab, not
   by loading a new URL. That's what makes fullscreen reliable here:
   the Fullscreen API only force-exits on top-level navigation, and
   this page simply never has one.

   Communication with the source tab's real embed player happens
   directly over chrome.runtime messaging (broadcasts reach every
   extension context with a listener — no manual relay needed for
   most of it). Navigation-specific requests (next/prev episode,
   "is there a next episode") go to the source tab\'s PARENT-page
   content script, which owns the real episode list.
================================================================= */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  let sourceTabId = params.get('sourceTab') ? parseInt(params.get('sourceTab'), 10) : null;

  const bootEl    = document.getElementById('wcp-boot');
  const bootMsg   = document.getElementById('wcp-boot-msg');
  const bootSub   = document.getElementById('wcp-boot-sub');
  const rootEl    = document.getElementById('wcp-root');

  const setBoot = (msg, sub = '', show = true) => {
    bootMsg.textContent = msg;
    bootSub.textContent = sub;
    bootEl.classList.toggle('hidden', !show);
  };

  const log = (...a) => console.log('[WCO-Popout]', ...a);

  // ── Resolve which tab we're mirroring ──────────────────────────────────
  const ready = new Promise((resolve) => {
    if (sourceTabId) { resolve(); return; }
    chrome.runtime.sendMessage({ type: 'WCO_POPOUT_WHOAMI' }, (res) => {
      sourceTabId = res?.sourceTabId ?? null;
      if (!sourceTabId) setBoot('No source tab found', 'Open this window from the player\'s pop-out button.');
      resolve();
    });
  });

  const isFS = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  const reqFS = el => { const fn = el.requestFullscreen || el.webkitRequestFullscreen; try { fn?.call(el); } catch {} };
  const exitFS = () => { const fn = document.exitFullscreen || document.webkitExitFullscreen; try { fn?.call(document); } catch {} };

  // ── Ask the source tab's embed player for its current state + qualities ──
  const requestInit = () => new Promise((resolve) => {
    chrome.tabs.sendMessage(sourceTabId, { type: 'WCO_POPOUT_INIT_REQUEST' }, (res) => resolve(res || null));
  });

  const sendCommand = (command, value) => {
    chrome.tabs.sendMessage(sourceTabId, { type: 'WCO_POPOUT_COMMAND', command, value });
  };

  let player = null; // set once buildPlayer() runs

  // ── HLS source attachment (VHS-sourced pop-outs) ────────────────────────
  // Standard embed sources are plain progressive MP4/FLV — vid.src is
  // enough. VHS episodes are HLS (.m3u8), which Chrome can't play
  // natively, so those get their own hls.js instance here instead. This
  // gives the pop-out REAL native audioTracks/subtitleTracks/levels to
  // build its Audio/Caption/Quality menus from — no need to relay clicks
  // back into the source tab's VJS menus at all for these.
  let hls = null;
  const attachSource = (vid, src, isHlsSrc, onTracksReady) => {
    if (hls) { try { hls.destroy(); } catch {} hls = null; }
    if (isHlsSrc && window.Hls && window.Hls.isSupported()) {
      hls = new Hls();
      const fire = () => { try { onTracksReady?.(); } catch {} };
      hls.on(Hls.Events.MANIFEST_PARSED, fire);
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, fire);
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, fire);
      hls.on(Hls.Events.LEVEL_SWITCHED, fire);
      hls.loadSource(src);
      hls.attachMedia(vid);
    } else {
      // Native HLS (Safari) or a non-HLS source either way.
      vid.src = src;
      if (isHlsSrc) onTracksReady?.();
    }
  };

  const buildPlayer = (initData) => {
    const { videoSrc, poster } = initData;

    const style = document.createElement('style');
    style.textContent = `
        #wcp {
          position: absolute; inset: 0; z-index: 2147483000;
          background: #000; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          user-select: none; -webkit-user-select: none; overflow: hidden;
        }
        #wcp video {
          width: 100%; height: 100%; display: block; background: #000; outline: none; object-fit: contain; cursor: pointer;
        }

        /* Glass Bar */
        #wcp-bar {
          position: absolute; bottom: 16px; left: 16px; right: 16px;
          background: rgba(26, 32, 42, 0.75);
          backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 12px; padding: 6px 14px;
          display: flex; align-items: center; gap: 8px;
          opacity: 0; transform: translateY(6px);
          transition: opacity 0.25s ease, transform 0.25s ease;
          z-index: 20; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
        }
        #wcp.wcp-ui #wcp-bar { opacity: 1; transform: translateY(0); }

        /* During an episode transition: bar stays visible (forced on,
           not left to the auto-hide timer) so it doesn't look like the
           player just died, but everything in it is grayed out and
           inert EXCEPT fullscreen — so the user can always back out of
           fullscreen instead of feeling stuck there while the next
           episode loads in. */
        #wcp-bar.wcp-locked { opacity: 1 !important; transform: translateY(0) !important; }
        #wcp-bar.wcp-locked > * {
          opacity: 0.32; filter: grayscale(1);
          pointer-events: none; cursor: default;
          transition: opacity 0.2s ease;
        }
        #wcp-bar.wcp-locked #wcp-fs-btn {
          opacity: 1 !important; filter: none !important;
          pointer-events: auto !important; cursor: pointer !important;
        }
        #wcp-bar.wcp-locked #wcp-fs-btn:hover { opacity: 0.8 !important; }

        .v10-btn {
          background: none; border: none; color: #f1f5f9; cursor: pointer;
          padding: 5px; display: flex; align-items: center; justify-content: center;
          border-radius: 6px; opacity: 0.85; transition: opacity 0.15s, background 0.15s;
          flex-shrink: 0;
        }
        .v10-btn:hover { opacity: 1; background: rgba(255, 255, 255, 0.12); }

        .v10-time {
          font-size: 13px; font-weight: 500; color: #e2e8f0;
          letter-spacing: 0.01em; white-space: nowrap; flex-shrink: 0;
        }

        /* Progress Bar */
        #wcp-prog-wrap {
          flex: 1; position: relative; height: 4px;
          background: rgba(255, 255, 255, 0.22); border-radius: 99px; cursor: pointer;
          transition: height 0.15s ease; display: flex; align-items: center;
        }
        #wcp-prog-wrap:hover { height: 6px; }
        #wcp-prog-buf { position: absolute; left: 0; top: 0; bottom: 0; background: rgba(255, 255, 255, 0.35); border-radius: 99px; pointer-events: none; }
        #wcp-prog-fill { position: absolute; left: 0; top: 0; bottom: 0; background: #ffffff; border-radius: 99px; pointer-events: none; }
        #wcp-prog-thumb {
          position: absolute; top: 50%; width: 10px; height: 10px;
          background: #ffffff; border-radius: 50%; transform: translate(-50%, -50%);
          pointer-events: none; opacity: 0; transition: opacity 0.15s;
          box-shadow: 0 0 6px rgba(0,0,0,0.5);
        }
        #wcp-prog-wrap:hover #wcp-prog-thumb { opacity: 1; }

        /* Split-episode chapter boundaries on the ONE combined scrubber
           (identical to the in-page player). */
        #wcp-chaps { position: absolute; inset: 0; pointer-events: none; }
        .wcp-chap {
          position: absolute; top: -3px; bottom: -3px; width: 3px; margin-left: -1.5px;
          background: rgba(12, 16, 24, 0.95); border-radius: 1px;
        }
        .wcp-chap-lbl {
          position: absolute; bottom: 11px; transform: translateX(-50%);
          font: 600 9px/1 system-ui, sans-serif; color: rgba(255,255,255,0.8);
          background: rgba(0,0,0,0.55); padding: 2px 4px; border-radius: 3px;
          opacity: 0; transition: opacity 0.15s; white-space: nowrap;
        }
        #wcp-prog-wrap:hover .wcp-chap-lbl { opacity: 1; }
        #wcp-prog-wrap.wcp-part-loading #wcp-prog-fill { opacity: 0.6; }
        #wcp-thumb-preview.wcp-no-frame #wcp-thumb-canvas { display: none; }
        #wcp-thumb-preview.wcp-no-frame #wcp-thumb-time { padding: 4px 8px; }

        /* Scrub thumbnail preview — real captured video frame */
        #wcp-thumb-preview {
          position: absolute; bottom: 22px; left: 0;
          transform: translateX(-50%);
          background: #000; border: 2px solid rgba(255,255,255,0.9);
          border-radius: 6px; overflow: hidden;
          box-shadow: 0 4px 16px rgba(0,0,0,0.6);
          pointer-events: none; opacity: 0; transition: opacity 0.12s;
          display: flex; flex-direction: column; align-items: center;
        }
        #wcp-thumb-preview.wcp-show { opacity: 1; }
        #wcp-thumb-canvas { display: block; width: 160px; height: 90px; background: #111; }
        #wcp-thumb-time {
          font: 600 11px/1 system-ui, sans-serif; color: #fff;
          background: rgba(0,0,0,0.8); padding: 3px 0; width: 100%;
          text-align: center;
        }

        /* Volume Slider */
        #wcp-vol-wrap { display: flex; align-items: center; gap: 4px; }
        #wcp-vol-slider {
          width: 0px; height: 4px; background: rgba(255,255,255,0.22);
          border-radius: 99px; cursor: pointer; accent-color: #ffffff;
          -webkit-appearance: none; appearance: none;
          transition: width 0.2s ease, opacity 0.2s ease; opacity: 0;
        }
        #wcp-vol-wrap:hover #wcp-vol-slider { width: 55px; opacity: 1; }
        #wcp-vol-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 10px; height: 10px; border-radius: 50%; background: #fff; cursor: pointer; }

        /* Flyout Settings Menu */
        #wcp-settings-menu {
          position: absolute; bottom: 68px; right: 16px;
          width: 210px; background: rgba(30, 36, 46, 0.9);
          backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 12px; padding: 6px; color: #f8fafc; z-index: 40;
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5); display: none; flex-direction: column; gap: 2px;
        }
        #wcp-settings-menu.open { display: flex; }

        .wcp-menu-panel { display: none; flex-direction: column; }
        .wcp-menu-panel.active { display: flex; }

        .wcp-menu-item {
          display: flex; align-items: center; justify-content: space-between;
          padding: 8px 10px; border-radius: 8px; cursor: pointer;
          font-size: 13px; font-weight: 500; transition: background 0.12s;
        }
        .wcp-menu-item:hover { background: rgba(255, 255, 255, 0.1); }
        .wcp-menu-left { display: flex; align-items: center; gap: 10px; }
        .wcp-menu-right { display: flex; align-items: center; gap: 4px; color: #94a3b8; font-size: 13px; }

        .wcp-menu-header {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.1);
          font-size: 12px; font-weight: 600; color: #94a3b8; cursor: pointer; margin-bottom: 4px;
        }
        .wcp-menu-header:hover { color: #fff; }

        .wcp-subitem {
          display: flex; align-items: center; justify-content: space-between;
          padding: 7px 10px 7px 28px; border-radius: 6px; cursor: pointer;
          font-size: 13px; color: #cbd5e1; transition: background 0.12s;
        }
        .wcp-subitem:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }
        .wcp-subitem.active { color: #38bdf8; font-weight: 600; position: relative; }
        .wcp-subitem.active::before { content: "✓"; position: absolute; left: 10px; font-size: 12px; }

        .wcp-subsection-label {
          font-size: 10px; font-weight: 700; letter-spacing: 0.06em;
          text-transform: uppercase; color: #6b7280;
          padding: 10px 10px 4px 28px; margin-top: 4px;
          border-top: 1px solid rgba(255,255,255,0.08);
        }

        /* Long Audio / Captions / Quality lists: ONLY the item list below
           the header scrolls — the .wcp-menu-header itself is untouched
           (not sticky, no background) and simply sits above it. */
        .wcp-subitem-list { display: flex; flex-direction: column; }
        .wcp-menu-panel.active .wcp-subitem-list {
          max-height: 260px; overflow-y: auto; overflow-x: hidden;
          scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.28) transparent;
        }
        .wcp-subitem-list::-webkit-scrollbar { width: 6px; }
        .wcp-subitem-list::-webkit-scrollbar-track { background: transparent; }
        .wcp-subitem-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.28); border-radius: 99px; }
        .wcp-subitem-list::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.45); }

        /* "Captions settings" entry at the bottom of the Captions panel —
           separated by the same divider line .wcp-subsection-label uses. */
        .wcp-cs-entry {
          display: flex; align-items: center; justify-content: space-between;
          padding: 8px 10px 7px 28px; margin-top: 4px; border-radius: 6px; cursor: pointer;
          font-size: 13px; color: #cbd5e1; transition: background 0.12s;
          border-top: 1px solid rgba(255,255,255,0.08);
        }
        .wcp-cs-entry:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }
        .wcp-cs-entry svg { color: #94a3b8; }

        /* Captions appearance panel (our own take on VideoJS's "captions
           settings" dialog), built from the same menu components. */
        #wcp-settings-menu:has(#wcp-panel-caption-style.active) { width: 250px; }
        .wcp-cs-body > .wcp-subsection-label { padding-left: 10px; }
        .wcp-cs-body > .wcp-subsection-label:first-child { border-top: none; margin-top: 0; padding-top: 4px; }
        .wcp-cs-row {
          display: flex; align-items: center; justify-content: space-between; gap: 8px;
          padding: 4px 10px; font-size: 12px; color: #cbd5e1;
        }
        .wcp-cs-row select {
          width: 128px; flex-shrink: 0; cursor: pointer; outline: none;
          background: rgba(255,255,255,0.08); color: #f8fafc;
          border: 1px solid rgba(255,255,255,0.14); border-radius: 6px;
          padding: 4px 6px; font: 500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          transition: background 0.12s, border-color 0.12s;
        }
        .wcp-cs-row select:hover { background: rgba(255,255,255,0.14); }
        .wcp-cs-row select:focus { border-color: #38bdf8; }
        .wcp-cs-row select option { background: #1e242e; color: #f8fafc; }
        .wcp-cs-actions {
          display: flex; gap: 6px; padding: 8px 4px 2px; margin-top: 4px;
          border-top: 1px solid rgba(255,255,255,0.08);
        }
        .wcp-cs-btn {
          flex: 1; padding: 6px 0; border-radius: 6px; cursor: pointer;
          border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.06);
          color: #cbd5e1; font: 600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          transition: background 0.12s, color 0.12s;
        }
        .wcp-cs-btn:hover { background: rgba(255,255,255,0.12); color: #fff; }
        .wcp-cs-btn.wcp-cs-primary { background: #38bdf8; border-color: transparent; color: #0b1220; }
        .wcp-cs-btn.wcp-cs-primary:hover { background: #5cc8fa; color: #0b1220; }

        /* First-load hint bubble pointing at the settings gear. Positioned
           (and its arrow aimed) from JS off the gear's real location. */
        #wcp-track-hint {
          position: absolute; right: 16px; bottom: 70px; z-index: 45; max-width: 230px;
          background: rgba(30, 36, 46, 0.95);
          backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
          border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 10px;
          padding: 10px 30px 10px 12px; color: #f8fafc;
          font-size: 12.5px; font-weight: 500; line-height: 1.4;
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
          opacity: 0; transform: translateY(6px); pointer-events: none;
          transition: opacity 0.25s ease, transform 0.25s ease;
        }
        #wcp-track-hint.wcp-show { opacity: 1; transform: translateY(0); pointer-events: auto; }
        #wcp-track-hint::after {
          content: ""; position: absolute; bottom: -6px; right: var(--wcp-hint-arrow, 18px);
          width: 10px; height: 10px; background: rgba(30, 36, 46, 0.95);
          border-right: 1px solid rgba(255, 255, 255, 0.14); border-bottom: 1px solid rgba(255, 255, 255, 0.14);
          transform: rotate(45deg);
        }
        #wcp-track-hint-close {
          position: absolute; top: 6px; right: 6px; width: 20px; height: 20px;
          display: flex; align-items: center; justify-content: center;
          background: none; border: none; border-radius: 5px; cursor: pointer;
          color: #94a3b8; font-size: 12px; line-height: 1;
        }
        #wcp-track-hint-close:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }
        /* Keep the bar (and so the gear being pointed at) visible while the hint is up */
        #wcp.wcp-hint-open #wcp-bar { opacity: 1; transform: translateY(0); }

        /* Spinner */
        #wcp-spinner { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; z-index: 12; pointer-events: none; }
        #wcp-spinner.on { display: flex; }
        #wcp-spin-ring { width: 42px; height: 42px; border: 3px solid rgba(255,255,255,0.15); border-top-color: #ffffff; border-radius: 50%; animation: wcp-spin 0.75s linear infinite; }
        @keyframes wcp-spin { to { transform: rotate(360deg); } }

        /* Next Episode Pill Overlay — sits above the glass control bar when it's
           visible, and drops down closer to the edge when the bar auto-hides,
           so it doesn't float awkwardly in empty space. */
        #wcp-ep-wrap {
          position: absolute; right: 16px; display: flex; align-items: center; gap: 8px; z-index: 30;
          bottom: 24px; /* default: controls hidden — sit near the bottom edge */
          opacity: 0; pointer-events: none; transform: translateY(8px);
          transition: opacity 0.25s, transform 0.25s, bottom 0.25s ease;
        }
        #wcp.wcp-ui #wcp-ep-wrap { bottom: 68px; } /* controls visible — sit above the glass bar */
        #wcp-ep-wrap.wcp-vis { opacity: 1; pointer-events: auto; transform: translateY(0); }
        .wcp-pill {
          background: rgba(26, 32, 42, 0.88); border: 1px solid rgba(255, 255, 255, 0.15);
          backdrop-filter: blur(12px); color: #fff; padding: 8px 14px; border-radius: 8px;
          font: 600 12px/1.3 system-ui, sans-serif; cursor: pointer; display: flex; align-items: center; gap: 8px;
          box-shadow: 0 4px 20px rgba(0,0,0,0.5); transition: background 0.12s;
        }
        .wcp-pill:hover { background: rgba(40, 48, 62, 0.95); }
        .wcp-pill-badge { background: #ffffff; color: #000; min-width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; }

        /* Prev / Next episode arrows — sit above the player, fade with the
           rest of the UI, opposite corners. */
        .wcp-ep-arrow {
          position: absolute; top: 14px; z-index: 25;
          width: 38px; height: 38px; border-radius: 50%;
          background: rgba(20,20,24,0.55); border: none; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          opacity: 0; pointer-events: none;
          transition: opacity 0.2s, background 0.15s;
        }
        #wcp.wcp-ui .wcp-ep-arrow.wcp-ep-arrow-show { opacity: 1; pointer-events: auto; }
        .wcp-ep-arrow:hover { background: rgba(40,40,46,0.85); }
        #wcp-ep-prev { left: 14px; }
        #wcp-ep-next { right: 14px; }

        /* Title overlay — same two-line layout as the site player, but
           shown whenever the controls are visible, NOT gated to
           fullscreen. The pop-out has no surrounding page — this is the
           only place its title shows up, so it needs to work in the
           normal windowed view too, not just fullscreen. */
        #wcp-title-overlay {
          position: absolute; top: 16px; left: 62px; right: 62px; z-index: 25;
          opacity: 0; pointer-events: none; transition: opacity 0.2s;
          text-shadow: 0 1px 6px rgba(0,0,0,0.85);
          white-space: nowrap; overflow: hidden;
        }
        #wcp-title-meta {
          color: rgba(255,255,255,0.75); font-size: 12px; font-weight: 600;
          overflow: hidden; text-overflow: ellipsis;
        }
        #wcp-title-show {
          color: #fff; font-size: 18px; font-weight: 700;
          overflow: hidden; text-overflow: ellipsis;
        }
        #wcp.wcp-ui #wcp-title-overlay { opacity: 1; }

      `;
    document.head.appendChild(style);

    // ── Caption appearance options (mirrors VideoJS's own "captions
    // settings" dialog option sets exactly). Same table lives in
    // content.js; both read/write chrome.storage 'wcoCaptionAppearance'.
    const CAP_COLORS = [['#FFF','White'],['#000','Black'],['#F00','Red'],['#0F0','Green'],['#00F','Blue'],['#FF0','Yellow'],['#F0F','Magenta'],['#0FF','Cyan']];
    const CAP_OPTS = {
      textColor:     CAP_COLORS,
      textOpacity:   [['1','Opaque'],['0.5','Semi-Transparent']],
      bgColor:       CAP_COLORS,
      bgOpacity:     [['1','Opaque'],['0.5','Semi-Transparent'],['0','Transparent']],
      windowColor:   CAP_COLORS,
      windowOpacity: [['0','Transparent'],['0.5','Semi-Transparent'],['1','Opaque']],
      fontSize:      [['0.5','50%'],['0.75','75%'],['1','100%'],['1.25','125%'],['1.5','150%'],['1.75','175%'],['2','200%'],['3','300%'],['4','400%']],
      edgeStyle:     [['none','None'],['raised','Raised'],['depressed','Depressed'],['uniform','Uniform'],['dropshadow','Drop shadow']],
      fontFamily:    [['proportionalSansSerif','Proportional Sans-Serif'],['monospaceSansSerif','Monospace Sans-Serif'],['proportionalSerif','Proportional Serif'],['monospaceSerif','Monospace Serif'],['casual','Casual'],['script','Script'],['small-caps','Small Caps']],
    };
    const capSelect = (key, label) =>
      `<label class="wcp-cs-row"><span>${label}</span><select data-cs="${key}">${CAP_OPTS[key].map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>`;

    const P = document.createElement('div');
    P.id = 'wcp';
    P.innerHTML = `
        <video id="wcp-vid" playsinline webkit-playsinline preload="auto" ${poster ? `poster="${poster}"` : ''}></video>

        <div id="wcp-spinner"><div id="wcp-spin-ring"></div></div>

        <!-- Fullscreen-only show/episode title -->
        <div id="wcp-title-overlay">
          <div id="wcp-title-meta"></div>
          <div id="wcp-title-show"></div>
        </div>

        <!-- Prev / Next episode arrows -->
        <button class="wcp-ep-arrow" id="wcp-ep-prev" title="Previous episode">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff">
            <rect x="4" y="5" width="2.5" height="14"/>
            <path d="M19 5v14L8 12z"/>
          </svg>
        </button>
        <button class="wcp-ep-arrow" id="wcp-ep-next" title="Next episode">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff">
            <path d="M5 5v14l11-7z"/>
            <rect x="17.5" y="5" width="2.5" height="14"/>
          </svg>
        </button>

        <!-- Next Episode Pill -->
        <div id="wcp-ep-wrap">
          <div class="wcp-pill" id="wcp-pill-keep">Keep Watching</div>
          <div class="wcp-pill" id="wcp-pill-next">
            <span id="wcp-pill-text">Next Episode</span>
            <div class="wcp-pill-badge" id="wcp-pill-timer">10</div>
          </div>
        </div>

        <!-- VideoJS v10 Settings Flyout -->
        <div id="wcp-settings-menu">
          <div class="wcp-menu-panel active" id="wcp-panel-main">
            <div class="wcp-menu-item" id="wcp-btn-opt-autoplay">
              <div class="wcp-menu-left">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                <span>Autoplay</span>
              </div>
              <div class="wcp-menu-right">
                <span id="wcp-lbl-autoplay">On</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
              </div>
            </div>
            <div class="wcp-menu-item" id="wcp-btn-opt-quality">
              <div class="wcp-menu-left">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/></svg>
                <span>Quality</span>
              </div>
              <div class="wcp-menu-right">
                <span id="wcp-lbl-quality">Auto</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
              </div>
            </div>
            <div class="wcp-menu-item" id="wcp-btn-opt-speed">
              <div class="wcp-menu-left">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l3 2"/></svg>
                <span>Speed</span>
              </div>
              <div class="wcp-menu-right">
                <span id="wcp-lbl-speed">1×</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
              </div>
            </div>
            <div class="wcp-menu-item" id="wcp-btn-opt-audio" style="display:none">
              <div class="wcp-menu-left">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                <span>Audio</span>
              </div>
              <div class="wcp-menu-right">
                <span id="wcp-lbl-audio">—</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
              </div>
            </div>
            <div class="wcp-menu-item" id="wcp-btn-opt-captions" style="display:none">
              <div class="wcp-menu-left">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 12h3M7 15h5M14 12h3M14 15h3"/></svg>
                <span>Captions</span>
              </div>
              <div class="wcp-menu-right">
                <span id="wcp-lbl-captions">Off</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
              </div>
            </div>
          </div>

          <div class="wcp-menu-panel" id="wcp-panel-autoplay">
            <div class="wcp-menu-header" id="wcp-autoplay-back">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
              <span>Autoplay</span>
            </div>
            <div class="wcp-subitem active" data-navmode="next">On</div>
            <div class="wcp-subitem" data-navmode="random">Random</div>
            <div class="wcp-subitem" data-navmode="off">Disabled</div>
            <div class="wcp-subsection-label">Countdown</div>
            <div class="wcp-subitem" data-cd="0">Disabled</div>
            <div class="wcp-subitem" data-cd="5">5s</div>
            <div class="wcp-subitem active" data-cd="10">10s</div>
            <div class="wcp-subitem" data-cd="15">15s</div>
          </div>

          <div class="wcp-menu-panel" id="wcp-panel-speed">
            <div class="wcp-menu-header" id="wcp-speed-back">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
              <span>Speed</span>
            </div>
            <div class="wcp-subitem" data-speed="0.5">0.5×</div>
            <div class="wcp-subitem" data-speed="0.75">0.75×</div>
            <div class="wcp-subitem active" data-speed="1">1× (Normal)</div>
            <div class="wcp-subitem" data-speed="1.25">1.25×</div>
            <div class="wcp-subitem" data-speed="1.5">1.5×</div>
            <div class="wcp-subitem" data-speed="2">2×</div>
          </div>


          <div class="wcp-menu-panel" id="wcp-panel-quality">
            <div class="wcp-menu-header" id="wcp-quality-back">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
              <span>Quality</span>
            </div>
            <!-- Quality items injected by JS after reading VJS dropdown -->
            <div class="wcp-subitem-list"></div>
          </div>

          <div class="wcp-menu-panel" id="wcp-panel-audio">
            <div class="wcp-menu-header" id="wcp-audio-back">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
              <span>Audio</span>
            </div>
            <!-- Audio track items injected by JS from hls.js audioTracks -->
            <div class="wcp-subitem-list"></div>
          </div>

          <div class="wcp-menu-panel" id="wcp-panel-captions">
            <div class="wcp-menu-header" id="wcp-captions-back">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
              <span>Captions</span>
            </div>
            <!-- Caption track items injected by JS from hls.js subtitleTracks -->
            <div class="wcp-subitem-list"></div>
            <div class="wcp-cs-entry" id="wcp-btn-caption-style" style="display:none">
              <span>Captions settings</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
            </div>
          </div>

          <div class="wcp-menu-panel" id="wcp-panel-caption-style">
            <div class="wcp-menu-header" id="wcp-caption-style-back">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
              <span>Captions settings</span>
            </div>
            <div class="wcp-subitem-list wcp-cs-body">
              <div class="wcp-subsection-label">Text</div>
              ${capSelect('textColor', 'Color')}
              ${capSelect('textOpacity', 'Opacity')}
              <div class="wcp-subsection-label">Text Background</div>
              ${capSelect('bgColor', 'Color')}
              ${capSelect('bgOpacity', 'Opacity')}
              <div class="wcp-subsection-label">Caption Area Background</div>
              ${capSelect('windowColor', 'Color')}
              ${capSelect('windowOpacity', 'Opacity')}
              <div class="wcp-subsection-label">Font</div>
              ${capSelect('fontSize', 'Font Size')}
              ${capSelect('edgeStyle', 'Text Edge Style')}
              ${capSelect('fontFamily', 'Font Family')}
            </div>
            <div class="wcp-cs-actions">
              <button class="wcp-cs-btn" id="wcp-cs-reset" type="button">Reset</button>
              <button class="wcp-cs-btn wcp-cs-primary" id="wcp-cs-done" type="button">Done</button>
            </div>
          </div>
        </div>

        <!-- First-load hint: points at the settings gear when an episode has dub/caption tracks -->
        <div id="wcp-track-hint" role="status">
          Please choose your language and subtitles in the settings menu!
          <button id="wcp-track-hint-close" type="button" title="Dismiss">✕</button>
        </div>

        <!-- VideoJS v10 Glass Control Bar -->
        <div id="wcp-bar">
          <button class="v10-btn" id="wcp-play-btn" title="Play / Pause">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff" id="wcp-play-svg"><path d="M8 5v14l11-7z"/></svg>
          </button>

          <!-- Sleek 10s Backward Button (< Arrow Left Arc) -->
          <button class="v10-btn" id="wcp-skip-back-btn" title="Rewind 10s">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 4.5A8.5 8.5 0 1 0 20.5 13"/>
              <path d="M15.5 2L12 4.5L15.5 7"/>
              <text x="12" y="15.5" font-size="8" font-family="system-ui, -apple-system, sans-serif" font-weight="700" fill="#ffffff" stroke="none" text-anchor="middle">10</text>
            </svg>
          </button>

          <!-- Sleek 10s Forward Button (> Arrow Right Arc) -->
          <button class="v10-btn" id="wcp-skip-fwd-btn" title="Forward 10s">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 4.5A8.5 8.5 0 1 1 3.5 13"/>
              <path d="M8.5 2L12 4.5L8.5 7"/>
              <text x="12" y="15.5" font-size="8" font-family="system-ui, -apple-system, sans-serif" font-weight="700" fill="#ffffff" stroke="none" text-anchor="middle">10</text>
            </svg>
          </button>

          <div id="wcp-vol-wrap">
            <button class="v10-btn" id="wcp-mute-btn" title="Mute">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff" id="wcp-vol-icon"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
            </button>
            <input type="range" id="wcp-vol-slider" min="0" max="1" step="0.02" value="1" data-restore="true">
          </div>

          <div class="v10-time" id="wcp-time-curr">0:00</div>

          <div id="wcp-prog-wrap">
            <div id="wcp-prog-buf"></div>
            <div id="wcp-prog-fill"></div>
            <div id="wcp-chaps"></div>
            <div id="wcp-prog-thumb"></div>
            <div id="wcp-thumb-preview">
              <canvas id="wcp-thumb-canvas" width="160" height="90"></canvas>
              <div id="wcp-thumb-time">0:00</div>
            </div>
          </div>

          <div class="v10-time" id="wcp-time-rem">-0:00</div>

          <button class="v10-btn" id="wcp-settings-btn" title="Settings">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>

          <button class="v10-btn" id="wcp-cast-btn" title="Cast" style="display:none">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 16.1A5 5 0 0 1 5.9 20"/>
              <path d="M2 12.05A9 9 0 0 1 9.95 20"/>
              <path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/>
              <circle cx="2" cy="20" r="1" fill="#fff" stroke="none"/>
            </svg>
          </button>

          <button class="v10-btn" id="wcp-pip-btn" title="Picture-in-Picture">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2"/><rect x="11" y="9" width="9" height="6" rx="1" fill="#fff"/>
            </svg>
          </button>

          <button class="v10-btn" id="wcp-popback-btn" title="Pop back into the tab">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 20V10a2 2 0 0 1 2-2h6"/><path d="M9 3h6v6"/><path d="M4 14L15 3"/>
            </svg>
          </button>

          <button class="v10-btn" id="wcp-fs-btn" title="Fullscreen">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
            </svg>
          </button>
        </div>
      `;
    rootEl.appendChild(P);

    // Move the loading/connecting overlay INSIDE the player element itself.
    // This matters specifically for fullscreen: the Fullscreen API puts
    // the fullscreened element into a special browser "top layer" that
    // renders above literally everything else on the page — but only for
    // elements INSIDE it. #wcp-boot started life as a sibling of #wcp (a
    // separate child of <body>), so once the user fullscreened the
    // player, the boot overlay could never render on top of it again, no
    // matter what z-index it had — it simply wasn't part of the same
    // rendering layer anymore. Making it a child of #wcp fixes this: it's
    // now part of the fullscreened subtree and stays visible correctly.
    P.appendChild(bootEl);

    // ── Element refs ──────────────────────────────────────────────────────
    const vid          = P.querySelector('#wcp-vid');
    const bar           = P.querySelector('#wcp-bar');
    const playBtn       = P.querySelector('#wcp-play-btn');
    const playIcon      = P.querySelector('#wcp-play-svg');
    const skipBackBtn   = P.querySelector('#wcp-skip-back-btn');
    const skipFwdBtn    = P.querySelector('#wcp-skip-fwd-btn');
    const muteBtn       = P.querySelector('#wcp-mute-btn');
    const volIcon       = P.querySelector('#wcp-vol-icon');
    const volSlider     = P.querySelector('#wcp-vol-slider');
    const timeCurr      = P.querySelector('#wcp-time-curr');
    const timeRem       = P.querySelector('#wcp-time-rem');
    const progWrap      = P.querySelector('#wcp-prog-wrap');
    const progFill      = P.querySelector('#wcp-prog-fill');
    const progBuf       = P.querySelector('#wcp-prog-buf');
    const progThumb     = P.querySelector('#wcp-prog-thumb');
    const fsBtn         = P.querySelector('#wcp-fs-btn');
    const pipBtn        = P.querySelector('#wcp-pip-btn');
    const castBtn       = P.querySelector('#wcp-cast-btn');
    const popbackBtn    = P.querySelector('#wcp-popback-btn');
    const settingsBtn   = P.querySelector('#wcp-settings-btn');
    const settingsMenu  = P.querySelector('#wcp-settings-menu');
    const spinner       = P.querySelector('#wcp-spinner');
    const epWrap        = P.querySelector('#wcp-ep-wrap');
    const keepBtn       = P.querySelector('#wcp-pill-keep');
    const nextBtn       = P.querySelector('#wcp-pill-next');
    const pillText      = P.querySelector('#wcp-pill-text');
    const pillTimer     = P.querySelector('#wcp-pill-timer');
    const epPrevBtn     = P.querySelector('#wcp-ep-prev');
    const epNextBtn     = P.querySelector('#wcp-ep-next');
    const thumbPreview  = P.querySelector('#wcp-thumb-preview');
    const thumbCanvas   = P.querySelector('#wcp-thumb-canvas');
    const thumbTimeEl   = P.querySelector('#wcp-thumb-time');

    // ── First-load "choose your language" hint bubble ─────────────────────
    // Same behavior + same storage key (wcoTrackHintSeen) as the in-page
    // player: shown once, ever, the first time an episode with real
    // dub/caption tracks loads; dismissed by ✕, by clicking the gear, or
    // by fading out on its own after ~8s — any of which marks it seen.
    const trackHint = P.querySelector('#wcp-track-hint');
    let trackHintState = 'idle'; // idle → pending (reading storage) → shown → done
    let trackHintTimer = null;
    const positionTrackHint = () => {
      if (!trackHint) return;
      const pr = P.getBoundingClientRect(), gr = settingsBtn.getBoundingClientRect();
      if (!gr.width) return;
      const gearFromRight = pr.right - (gr.left + gr.width / 2);
      const right = Math.max(8, gearFromRight - 24);
      trackHint.style.right = right + 'px';
      trackHint.style.bottom = Math.max(8, pr.bottom - gr.top + 10) + 'px';
      trackHint.style.setProperty('--wcp-hint-arrow', Math.max(8, gearFromRight - right - 6) + 'px');
    };
    const dismissTrackHint = () => {
      if (trackHintState === 'idle' || trackHintState === 'done') return;
      trackHintState = 'done';
      clearTimeout(trackHintTimer);
      trackHint?.classList.remove('wcp-show');
      P.classList.remove('wcp-hint-open');
      chrome.storage.local.set({ wcoTrackHintSeen: true });
    };
    const maybeShowTrackHint = () => {
      if (trackHintState !== 'idle' || !trackHint) return;
      trackHintState = 'pending';
      chrome.storage.local.get({ wcoTrackHintSeen: false }, r => {
        if (trackHintState !== 'pending') return;
        if (r.wcoTrackHintSeen) { trackHintState = 'done'; return; }
        trackHintState = 'shown';
        positionTrackHint();
        P.classList.add('wcp-hint-open');
        trackHint.classList.add('wcp-show');
        trackHintTimer = setTimeout(dismissTrackHint, 8000);
      });
    };
    trackHint?.querySelector('#wcp-track-hint-close')?.addEventListener('click', e => { e.stopPropagation(); dismissTrackHint(); });
    trackHint?.addEventListener('click', e => e.stopPropagation());
    window.addEventListener('resize', () => { if (trackHintState === 'shown') positionTrackHint(); });

    vid.poster = poster || '';
    vid.volume = typeof initData.volume === 'number' ? initData.volume : 1;
    vid.muted  = !!initData.muted;

    // ════════════════════════════════════════════════════════════════════
    //  MERGED MULTI-PART TIMELINE — same model as the in-page player:
    //  one <video>, one scrubber; combined = offsets[partIdx] + local.
    //  The embed sends the ordered parts WITH durations, so no probing is
    //  needed here. `parts` stays null for normal single-video episodes.
    //  Part swaps happen LOCALLY here (on 'ended' / on seek) — the pop-out
    //  never waits on the source tab to tell it which part to show.
    // ════════════════════════════════════════════════════════════════════
    let parts = null, offsets = [0], partIdx = 0, pendingSwap = null, swapToken = 0;
    let curIsHls = !!initData.isHls;
    const totalDur = () => parts ? offsets[parts.length] : (vid.duration || 0);
    const curT = () => {
      if (!parts) return vid.currentTime || 0;
      if (pendingSwap) return offsets[pendingSwap.i] + pendingSwap.local;
      return offsets[partIdx] + (vid.currentTime || 0);
    };
    const partAt = T => { for (let i = parts.length - 1; i > 0; i--) if (T >= offsets[i]) return i; return 0; };
    const renderChapters = () => {
      const box = P.querySelector('#wcp-chaps');
      box.innerHTML = '';
      const tot = totalDur();
      if (!parts || !tot) return;
      parts.forEach((p, i) => {
        if (i > 0) {
          const tick = document.createElement('div');
          tick.className = 'wcp-chap';
          tick.style.left = (offsets[i] / tot * 100) + '%';
          box.appendChild(tick);
        }
        const lbl = document.createElement('div');
        lbl.className = 'wcp-chap-lbl';
        lbl.style.left = ((offsets[i] + offsets[i + 1]) / 2 / tot * 100) + '%';
        lbl.textContent = 'P' + (i + 1);
        box.appendChild(lbl);
      });
    };
    const recomputeOffsets = () => {
      offsets = [0];
      parts.forEach((p, i) => offsets.push(offsets[i] + (p.duration || 0)));
      renderChapters();
    };
    // Adopt a part list (or null for a single video). Does NOT touch what
    // is currently attached — callers decide what to load.
    const setParts = list => {
      if (Array.isArray(list) && list.length >= 2 && list.every(p => p && p.src && p.duration > 0)) {
        parts = list.map(p => ({ src: p.src, poster: p.poster || '', isHls: !!p.isHls, duration: p.duration }));
        recomputeOffsets();
      } else {
        parts = null; offsets = [0]; renderChapters();
      }
      // Standard-embed quality can't be re-signed for merged parts.
      const qb = P.querySelector('#wcp-btn-opt-quality');
      if (qb) qb.style.display = (parts && !parts[0].isHls) ? 'none' : '';
    };
    // Attach a single (non-merged) source, landing at `at` seconds.
    const loadSingle = (src, isHlsSrc, at) => {
      pendingSwap = null; ++swapToken;
      curIsHls = !!isHlsSrc;
      attachSource(vid, src, curIsHls, () => populateHlsMenus());
      setThumbSource(src, curIsHls);
      vid.addEventListener('loadedmetadata', () => { if (at) { try { vid.currentTime = at; } catch {} } }, { once: true });
    };
    const loadPart = (i, local, play) => {
      const token = ++swapToken;
      pendingSwap = { i, local: Math.max(0, local || 0), play: !!play };
      partIdx = i;
      progWrap.classList.add('wcp-part-loading');
      spinner.classList.add('on');
      vid.addEventListener('loadedmetadata', () => {
        if (token !== swapToken || !pendingSwap) return;
        const { local: at, play: resume } = pendingSwap;
        pendingSwap = null;
        if (isFinite(vid.duration) && vid.duration > 0 && Math.abs(parts[i].duration - vid.duration) > 0.5) {
          parts[i].duration = vid.duration;
          recomputeOffsets();
        }
        try { vid.currentTime = Math.min(at, Math.max(0, (vid.duration || at + 1) - 0.5)); } catch {}
        progWrap.classList.remove('wcp-part-loading');
        if (resume) vid.play().then(updatePlayIcon).catch(updatePlayIcon); else spinner.classList.remove('on');
        renderProgress();
      }, { once: true });
      curIsHls = !!parts[i].isHls;
      attachSource(vid, parts[i].src, curIsHls, () => populateHlsMenus());
      if (parts[i].poster) vid.poster = parts[i].poster;
      renderProgress();
    };
    // Every seek (scrubber, ±10s, keys) goes through here; T is COMBINED.
    const seekCombined = T => {
      if (!parts) { const d = vid.duration || 0; vid.currentTime = Math.max(0, d ? Math.min(d, T) : T); return; }
      T = Math.max(0, Math.min(totalDur() - 0.25, T));
      const i = partAt(T), local = T - offsets[i];
      if (pendingSwap) {
        if (pendingSwap.i === i) { pendingSwap.local = local; renderProgress(); return; }
        loadPart(i, local, pendingSwap.play);
        return;
      }
      if (i === partIdx) { vid.currentTime = local; renderProgress(); return; }
      loadPart(i, local, !vid.paused);
    };
    vid.addEventListener('durationchange', () => {
      if (!parts || pendingSwap || !isFinite(vid.duration) || vid.duration <= 0) return;
      if (Math.abs(parts[partIdx].duration - vid.duration) > 0.5) { parts[partIdx].duration = vid.duration; recomputeOffsets(); }
    });
    // Start a (new) episode: merged if the embed sent parts, else single.
    const startEpisode = (data) => {
      setParts(data.parts);
      log('startEpisode:', parts ? `${parts.length} parts, part ${(data.partIndex || 0) + 1} @ ${(+data.currentTime || 0).toFixed(1)}s` : 'single video');
      if (parts) {
        const i = Math.min(Math.max(0, data.partIndex || 0), parts.length - 1);
        setThumbSource(parts[i].src, parts[i].isHls);
        loadPart(i, data.currentTime || 0, false);
      } else {
        loadSingle(data.videoSrc, !!data.isHls, data.currentTime || 0);
      }
    };
    // Same episode, but the embed only just finished building its merged
    // timeline (parts arrive a few seconds after the first sync): adopt
    // it in place — we're already playing part 1, so nothing reloads.
    const adoptParts = (list) => {
      if (parts || !Array.isArray(list) || list.length < 2) return;
      setParts(list);
      partIdx = 0;
      renderProgress();
    };

    // ── Helpers ───────────────────────────────────────────────────────────
    const fmt = s => {
      s = Math.max(0, Math.floor(s || 0)); // never render negative (combined time can overshoot by a few ms)
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      return h ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
    };

    // Bug fix: playIcon is the <svg> wrapper, not the <path> inside it —
    // setAttribute('d', ...) on an <svg> element does nothing at all (it's
    // not a recognized SVG attribute there). That's why the icon never
    // visually switched to the pause shape: the "play" triangle is what's
    // already baked into the HTML by default, so pausing (which needs no
    // visual change to look "correct") seemed to work, while playing
    // (which actually needs the shape to change) silently never did.
    const updatePlayIcon = () => {
      const path = playIcon.querySelector('path');
      if (path) path.setAttribute('d', vid.paused ? 'M8 5v14l11-7z' : 'M6 19h4V5H6v14zm8-14v14h4V5h-4z');
    };
    const VOL_ON  = 'M11 5L6 9H2v6h4l5 4V5z';
    const VOL_OFF = 'M11 5L6 9H2v6h4l5 4V5z M23 9l-6 6M17 9l6 6';
    const updateVolIcon = () => {
      const p = volIcon.querySelector('path');
      if (p) p.setAttribute('d', vid.muted || vid.volume === 0 ? VOL_OFF : VOL_ON);
    };

    const togglePlay = () => {
      if (vid.paused) { vid.play().then(updatePlayIcon).catch(updatePlayIcon); sendCommand('play'); }
      else { vid.pause(); updatePlayIcon(); sendCommand('pause'); }
    };

    // ── UI auto-hide ──────────────────────────────────────────────────────
    let uiTimer;
    const showUI = () => {
      P.classList.add('wcp-ui');
      clearTimeout(uiTimer);
      if (!vid.paused) uiTimer = setTimeout(() => P.classList.remove('wcp-ui'), 3000);
    };
    P.addEventListener('mousemove', showUI);
    // Mirror the control bar's visibility onto the sync-status badge (it
    // lives outside #wcp-root in the static shell, so a CSS sibling
    // selector can't reach it — this observer keeps it in step instead).
    // Also hidden while the settings flyout is open, since it opens from
    // the same bottom-right corner the badge sits in and would overlap it.
    if (typeof syncBadge !== 'undefined' && syncBadge) {
      const mirrorBadgeUI = () => syncBadge.classList.toggle(
        'wcp-uivis', P.classList.contains('wcp-ui') && !settingsMenu.classList.contains('open')
      );
      new MutationObserver(mirrorBadgeUI).observe(P, { attributes: true, attributeFilter: ['class'] });
      new MutationObserver(mirrorBadgeUI).observe(settingsMenu, { attributes: true, attributeFilter: ['class'] });
      mirrorBadgeUI();
    }
    P.addEventListener('click', e => {
      if (e.target.closest('#wcp-bar, #wcp-ep-wrap, #wcp-settings-menu')) return;
      togglePlay(); showUI();
    });
    vid.addEventListener('pause', () => { P.classList.add('wcp-ui'); clearTimeout(uiTimer); updatePlayIcon(); });
    vid.addEventListener('play',  () => { showUI(); updatePlayIcon(); });
    showUI();

    playBtn.addEventListener('click', e => { e.stopPropagation(); togglePlay(); });
    skipBackBtn.addEventListener('click', e => { e.stopPropagation(); seekCombined(curT() - 10); });
    skipFwdBtn.addEventListener('click',  e => { e.stopPropagation(); seekCombined(Math.min(totalDur() || 0, curT() + 10)); });

    // ── Progress bar + scrub thumbnail (reuses a second hidden video) ──────
    const thumbVid = document.createElement('video');
    // Scrub-bar thumbnail preview only works off a plain progressive src —
    // skip it for HLS (.m3u8) sources rather than feeding it a URL it
    // can't play.
    thumbVid.muted = true; thumbVid.preload = 'auto'; thumbVid.style.display = 'none';
    P.appendChild(thumbVid);
    let thumbSrc = null;
    function setThumbSource(src, isHlsSrc) {
      thumbPreview.classList.toggle('wcp-no-frame', !!isHlsSrc);
      if (isHlsSrc) { thumbSrc = null; return; }
      if (src && src !== thumbSrc) { thumbSrc = src; thumbSeekPending = false; thumbVid.src = src; }
    }
    const thumbCtx = thumbCanvas.getContext('2d');
    let thumbSeekPending = false, thumbWantedTime = 0;
    thumbVid.addEventListener('seeked', () => {
      try { thumbCtx.drawImage(thumbVid, 0, 0, thumbCanvas.width, thumbCanvas.height); } catch {}
      thumbSeekPending = false;
      if (Math.abs(thumbVid.currentTime - thumbWantedTime) > 0.5) { thumbSeekPending = true; thumbVid.currentTime = thumbWantedTime; }
    });
    const updateThumb = clientX => {
      const tot = totalDur();
      if (!tot) return;
      const r = progWrap.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      const t = pct * tot;
      const pi = parts ? partAt(t) : 0;
      const local = parts ? t - offsets[pi] : t;
      if (!thumbPreview.classList.contains('wcp-no-frame')) {
        thumbWantedTime = local;
        if (parts && parts[pi].src !== thumbSrc) {
          setThumbSource(parts[pi].src, parts[pi].isHls);
          thumbSeekPending = true;
          thumbVid.addEventListener('loadedmetadata', () => { try { thumbVid.currentTime = thumbWantedTime; } catch {} }, { once: true });
        } else if (!thumbSeekPending) { thumbSeekPending = true; try { thumbVid.currentTime = local; } catch {} }
      }
      thumbTimeEl.textContent = parts ? `P${pi + 1} · ${fmt(t)}` : fmt(t);
      const leftPx = Math.max(85, Math.min(r.width - 85, clientX - r.left));
      thumbPreview.style.left = leftPx + 'px';
      thumbPreview.classList.add('wcp-show');
    };
    const hideThumb = () => thumbPreview.classList.remove('wcp-show');

    let dragging = false;
    const seekPct = clientX => { const r = progWrap.getBoundingClientRect(); return Math.max(0, Math.min(1, (clientX - r.left) / r.width)); };
    const applySeek = pct => { const t = pct * totalDur(); seekCombined(t); sendCommand('seek', t); };
    // Guard against seeking a video that's about to be replaced — during
    // the brief window while the next episode is loading in, the old
    // frame is still technically visible/seekable, and any seek there is
    // meaningless the instant the new src arrives (felt like "desync").
    progWrap.addEventListener('mousedown', e => { if (awaitingNewEpisode) return; dragging = true; applySeek(seekPct(e.clientX)); showUI(); });
    window.addEventListener('mousemove', e => { if (dragging) applySeek(seekPct(e.clientX)); if (progWrap.matches(':hover')) updateThumb(e.clientX); });
    window.addEventListener('mouseup', () => { dragging = false; });
    progWrap.addEventListener('mouseleave', hideThumb);

    // Combined time/duration when merged, plain values otherwise.
    function renderProgress() {
      const tot = totalDur();
      if (!tot) return;
      const t = curT();
      const pct = Math.max(0, Math.min(100, (t / tot) * 100));
      progFill.style.width = pct + '%';
      progThumb.style.left = `calc(${pct}% - 5px)`;
      timeCurr.textContent = fmt(t);
      timeRem.textContent  = `-${fmt(tot - t)}`;
      try {
        if (vid.buffered.length && !pendingSwap) {
          const base = parts ? offsets[partIdx] : 0;
          progBuf.style.width = Math.min(100, ((base + vid.buffered.end(vid.buffered.length-1)) / tot) * 100) + '%';
        }
      } catch {}
    }
    vid.addEventListener('timeupdate', () => { if (!pendingSwap) renderProgress(); });

    // ── Volume ────────────────────────────────────────────────────────────
    muteBtn.addEventListener('click', e => { e.stopPropagation(); vid.muted = !vid.muted; updateVolIcon(); sendCommand('toggleMute'); });
    volSlider.value = vid.muted ? 0 : vid.volume;
    volSlider.addEventListener('input', () => {
      vid.volume = parseFloat(volSlider.value); vid.muted = vid.volume === 0;
      updateVolIcon();
      sendCommand('setVolume', vid.volume);
    });
    updateVolIcon(); // reflect the initial restored volume/mute state

    // ── Spinner ───────────────────────────────────────────────────────────
    vid.addEventListener('waiting', () => spinner.classList.add('on'));
    vid.addEventListener('canplay', () => spinner.classList.remove('on'));

    popbackBtn.addEventListener('click', e => {
      e.stopPropagation();
      chrome.tabs.sendMessage(sourceTabId, { type: 'WCO_POPOUT_POP_BACK_IN' });
      window.close();
    });

    // ── Fullscreen — this page never navigates, so unlike the main site,
    // the Fullscreen API's "exit on navigate" rule never fires here. ──────
    fsBtn.addEventListener('click', e => { e.stopPropagation(); isFS() ? exitFS() : reqFS(P); });
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(ev =>
      document.addEventListener(ev, () => P.classList.toggle('wcp-is-fullscreen', isFS()))
    );
    let pendingAutoFs = false;
    chrome.storage.local.get({ popoutAutoFullscreen: false }, p => {
      if (p.popoutAutoFullscreen && !isFS()) {
        pendingAutoFs = true;
        const arm = () => { if (pendingAutoFs) { pendingAutoFs = false; reqFS(P); } };
        window.addEventListener('click', arm, { once: true });
        window.addEventListener('keydown', arm, { once: true });
      }
    });

    // ── PiP ───────────────────────────────────────────────────────────────
    pipBtn.addEventListener('click', async e => {
      e.stopPropagation();
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else if (document.pictureInPictureEnabled) await vid.requestPictureInPicture();
      } catch {}
    });

    // ── Cast (Remote Playback API — same as the embed player) ──────────────
    if (castBtn && 'remote' in vid) {
      vid.remote.watchAvailability(av => { castBtn.style.display = av ? '' : 'none'; }).catch(() => { castBtn.style.display = ''; });
      castBtn.addEventListener('click', async e => { e.stopPropagation(); try { await vid.remote.prompt(); } catch {} });
    }

    // ── Settings menu: Autoplay+Countdown (direct chrome.storage — shared
    // prefs, no relay needed), Quality (relayed to the real VJS instance to
    // resolve), Speed (local only). ─────────────────────────────────────────
    settingsBtn.addEventListener('click', e => { e.stopPropagation(); dismissTrackHint(); settingsMenu.classList.toggle('open'); showSubpanel('wcp-panel-main'); });
    document.addEventListener('click', () => settingsMenu.classList.remove('open'));

    const showSubpanel = id => {
      settingsMenu.querySelectorAll('.wcp-menu-panel').forEach(p2 => p2.classList.toggle('active', p2.id === id));
    };
    P.querySelector('#wcp-btn-opt-autoplay').addEventListener('click', e => { e.stopPropagation(); refreshAutoplayMenu(); showSubpanel('wcp-panel-autoplay'); });
    P.querySelector('#wcp-autoplay-back').addEventListener('click', e => { e.stopPropagation(); showSubpanel('wcp-panel-main'); });
    P.querySelector('#wcp-btn-opt-speed').addEventListener('click', e => { e.stopPropagation(); showSubpanel('wcp-panel-speed'); });
    P.querySelector('#wcp-speed-back').addEventListener('click', e => { e.stopPropagation(); showSubpanel('wcp-panel-main'); });
    P.querySelector('#wcp-btn-opt-quality').addEventListener('click', e => { e.stopPropagation(); showSubpanel('wcp-panel-quality'); });
    P.querySelector('#wcp-quality-back').addEventListener('click', e => { e.stopPropagation(); showSubpanel('wcp-panel-main'); });

    // Autoplay + Countdown — shared chrome.storage prefs, same as the site.
    // refreshAutoplayMenu() re-reads storage each time so the checkmarks
    // never go stale if the setting was changed from the extension popup
    // while this menu wasn't open to see it happen.
    const autoplayLbl = P.querySelector('#wcp-lbl-autoplay');
    const NAVMODE_LABEL = { next: 'On', random: 'Random', off: 'Disabled' };
    const refreshAutoplayMenu = () => {
      chrome.storage.local.get({ navMode: 'next', countdownDuration: 10 }, p => {
        autoplayLbl.textContent = NAVMODE_LABEL[p.navMode] || 'On';
        P.querySelectorAll('#wcp-panel-autoplay .wcp-subitem[data-navmode]').forEach(i => i.classList.toggle('active', i.dataset.navmode === p.navMode));
        const cd = p.countdownDuration || 0;
        P.querySelectorAll('#wcp-panel-autoplay .wcp-subitem[data-cd]').forEach(i => i.classList.toggle('active', parseInt(i.dataset.cd) === cd));
      });
    };
    refreshAutoplayMenu();
    P.querySelectorAll('#wcp-panel-autoplay .wcp-subitem[data-navmode]').forEach(item => {
      item.addEventListener('click', e => {
        e.stopPropagation();
        P.querySelectorAll('#wcp-panel-autoplay .wcp-subitem[data-navmode]').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        chrome.storage.local.set({ navMode: item.dataset.navmode });
        autoplayLbl.textContent = NAVMODE_LABEL[item.dataset.navmode] || 'On';
        settingsMenu.classList.remove('open');
      });
    });
    P.querySelectorAll('#wcp-panel-autoplay .wcp-subitem[data-cd]').forEach(item => {
      item.addEventListener('click', e => {
        e.stopPropagation();
        P.querySelectorAll('#wcp-panel-autoplay .wcp-subitem[data-cd]').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        chrome.storage.local.set({ countdownDuration: parseInt(item.dataset.cd) });
        settingsMenu.classList.remove('open');
      });
    });

    // Speed — applied locally AND relayed to the source tab, so its
    // dormant copy is already correct whenever it's popped back in.
    const speedLbl = P.querySelector('#wcp-lbl-speed');
    P.querySelectorAll('#wcp-panel-speed .wcp-subitem').forEach(item => {
      item.addEventListener('click', e => {
        e.stopPropagation();
        const spd = parseFloat(item.dataset.speed);
        vid.playbackRate = spd;
        sendCommand('setSpeed', spd);
        P.querySelectorAll('#wcp-panel-speed .wcp-subitem').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        speedLbl.textContent = spd + '×';
        settingsMenu.classList.remove('open');
      });
    });

    // Quality — populated from the init handshake, resolved on demand via
    // the source tab's real VJS instance (only it can produce valid URLs).
    // Items live in each panel's inner .wcp-subitem-list (the scrollable
    // part), below — never beside — the untouched .wcp-menu-header.
    const qualityPanel = P.querySelector('#wcp-panel-quality .wcp-subitem-list');
    const qualityLbl   = P.querySelector('#wcp-lbl-quality');
    qualityLbl.textContent = initData.currentQuality || 'Auto';
    (initData.qualities || []).forEach(({ code, label }) => {
      const item = document.createElement('div');
      item.className = 'wcp-subitem' + (label === initData.currentQuality ? ' active' : '');
      item.textContent = label;
      qualityPanel.appendChild(item);
      item.addEventListener('click', e => {
        e.stopPropagation();
        const savedTime = vid.currentTime, wasPaused = vid.paused;
        qualityPanel.querySelectorAll('.wcp-subitem').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        qualityLbl.textContent = label;
        settingsMenu.classList.remove('open');
        spinner.classList.add('on');
        chrome.tabs.sendMessage(sourceTabId, { type: 'WCO_POPOUT_RESOLVE_QUALITY', code }, (res) => {
          if (res?.url) {
            vid.src = res.url;
            vid.addEventListener('loadedmetadata', () => {
              vid.currentTime = savedTime;
              spinner.classList.remove('on');
              if (!wasPaused) vid.play().catch(() => {});
            }, { once: true });
            vid.load();
          } else {
            spinner.classList.remove('on');
          }
        });
      });
    });

    P.querySelector('#wcp-btn-opt-audio').addEventListener('click', e => { e.stopPropagation(); showSubpanel('wcp-panel-audio'); });
    P.querySelector('#wcp-audio-back').addEventListener('click', e => { e.stopPropagation(); showSubpanel('wcp-panel-main'); });
    P.querySelector('#wcp-btn-opt-captions').addEventListener('click', e => { e.stopPropagation(); showSubpanel('wcp-panel-captions'); });
    P.querySelector('#wcp-captions-back').addEventListener('click', e => { e.stopPropagation(); showSubpanel('wcp-panel-main'); });

    // ── Captions settings (appearance) — identical to the in-page player's
    // (see content.js for the full notes). Styles hls.js's native <track>
    // cues through ::cue on our <video>, via a dedicated
    // <style id="wcp-caption-style"> rewritten on every change; persisted
    // to chrome.storage 'wcoCaptionAppearance' and live-synced both ways.
    // Known limitation: the "Caption Area Background" (VJS "window") has no
    // ::cue equivalent — approximated via Chrome's internal
    // ::-webkit-media-text-track-display box (own rule, so an unsupported
    // selector can't break the rest) and, when the text background is
    // Transparent, by painting the cue background with the window color.
    const CAP_DEFAULTS = { textColor: '#FFF', textOpacity: '1', bgColor: '#000', bgOpacity: '1', windowColor: '#000', windowOpacity: '0', fontSize: '1', edgeStyle: 'none', fontFamily: 'proportionalSansSerif' };
    const CAP_FONTS = {
      proportionalSansSerif: 'Arial, "Helvetica Neue", Helvetica, sans-serif',
      monospaceSansSerif:    '"Andale Mono", "Lucida Console", monospace',
      proportionalSerif:     '"Times New Roman", Times, serif',
      monospaceSerif:        '"Courier New", Courier, monospace',
      casual:                '"Comic Sans MS", Impact, fantasy',
      script:                '"Monotype Corsiva", cursive',
      'small-caps':          'Arial, "Helvetica Neue", Helvetica, sans-serif',
    };
    const CAP_EDGES = {
      none:       'none',
      raised:     '1px 1px #222, 2px 2px #222, 3px 3px #222',
      depressed:  '1px 1px #ccc, 0 1px #ccc, -1px -1px #222, 0 -1px #222',
      uniform:    '0 0 4px #222, 0 0 4px #222, 0 0 4px #222, 0 0 4px #222',
      dropshadow: '2px 2px 3px #222, 2px 2px 4px #222, 2px 2px 5px #222',
    };
    const capRgba = (hex, a) => {
      let h = String(hex || '#000').replace('#', '');
      if (h.length === 3) h = h.split('').map(c => c + c).join('');
      const n = parseInt(h, 16) || 0;
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${parseFloat(a)})`;
    };
    const buildCaptionCss = s => {
      if (Object.keys(CAP_DEFAULTS).every(k => String(s[k]) === CAP_DEFAULTS[k])) return ''; // native look untouched
      const winOn = parseFloat(s.windowOpacity) > 0;
      const cueBg = parseFloat(s.bgOpacity) > 0 ? capRgba(s.bgColor, s.bgOpacity)
                  : (winOn ? capRgba(s.windowColor, s.windowOpacity) : 'transparent');
      let css = `#wcp-vid::cue {
        color: ${capRgba(s.textColor, s.textOpacity)};
        background-color: ${cueBg};
        font-size: ${Math.round(parseFloat(s.fontSize) * 100) || 100}%;
        font-family: ${CAP_FONTS[s.fontFamily] || CAP_FONTS.proportionalSansSerif};
        font-variant: ${s.fontFamily === 'small-caps' ? 'small-caps' : 'normal'};
        text-shadow: ${CAP_EDGES[s.edgeStyle] || 'none'};
      }`;
      if (winOn) css += `
      #wcp-vid::-webkit-media-text-track-display {
        background-color: ${capRgba(s.windowColor, s.windowOpacity)}; padding: 2px 6px; border-radius: 2px;
      }`;
      return css;
    };
    const capStyleEl = document.getElementById('wcp-caption-style') || document.createElement('style');
    capStyleEl.id = 'wcp-caption-style';
    document.head.appendChild(capStyleEl);
    const capPanel = P.querySelector('#wcp-panel-caption-style');
    let capSettings = { ...CAP_DEFAULTS };
    const applyCaptionAppearance = saved => {
      capSettings = { ...CAP_DEFAULTS };
      if (saved && typeof saved === 'object') Object.keys(CAP_DEFAULTS).forEach(k => { if (saved[k] != null) capSettings[k] = String(saved[k]); });
      capStyleEl.textContent = buildCaptionCss(capSettings);
      capPanel.querySelectorAll('select[data-cs]').forEach(sel => { sel.value = capSettings[sel.dataset.cs]; });
    };
    chrome.storage.local.get({ wcoCaptionAppearance: null }, r => applyCaptionAppearance(r.wcoCaptionAppearance));
    // Our OWN writes echo back through onChanged asynchronously; ignore those
    // echoes, otherwise two quick changes in a row could snap the first
    // one's (stale) object back over the second.
    const ownCapWrites = [];
    const saveCaptionAppearance = v => {
      ownCapWrites.push({ j: JSON.stringify(v || null), t: Date.now() });
      if (v) chrome.storage.local.set({ wcoCaptionAppearance: v });
      else chrome.storage.local.remove('wcoCaptionAppearance');
    };
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || !ch.wcoCaptionAppearance) return;
      while (ownCapWrites.length && Date.now() - ownCapWrites[0].t > 3000) ownCapWrites.shift();
      const i = ownCapWrites.findIndex(w => w.j === JSON.stringify(ch.wcoCaptionAppearance.newValue || null));
      if (i >= 0) { ownCapWrites.splice(i, 1); return; }
      applyCaptionAppearance(ch.wcoCaptionAppearance.newValue);
    });
    capPanel.querySelectorAll('select[data-cs]').forEach(sel => sel.addEventListener('change', () => {
      const next = { ...capSettings, [sel.dataset.cs]: sel.value };
      applyCaptionAppearance(next);
      saveCaptionAppearance(next);
      sel.blur();
    }));
    capPanel.addEventListener('click', e => e.stopPropagation()); // keep the document-level "click closes menu" away
    P.querySelector('#wcp-btn-caption-style').addEventListener('click', e => { e.stopPropagation(); showSubpanel('wcp-panel-caption-style'); });
    P.querySelector('#wcp-caption-style-back').addEventListener('click', e => { e.stopPropagation(); showSubpanel('wcp-panel-captions'); });
    P.querySelector('#wcp-cs-reset').addEventListener('click', e => {
      e.stopPropagation();
      applyCaptionAppearance(null);
      saveCaptionAppearance(null); // Reset = back to defaults (stored key removed)
    });
    P.querySelector('#wcp-cs-done').addEventListener('click', e => { e.stopPropagation(); settingsMenu.classList.remove('open'); });

    // ── HLS tracks (VHS-sourced pop-outs only) — real audio dubs and
    // caption/subtitle tracks read straight from hls.js, and quality
    // levels the same way, all switched locally with no relay back to
    // the source tab needed. Called once the manifest (and whenever the
    // track lists) are (re)parsed — see attachSource() above.
    const audioBtnEl = P.querySelector('#wcp-btn-opt-audio');
    const audioPanel = P.querySelector('#wcp-panel-audio .wcp-subitem-list');
    const audioLbl   = P.querySelector('#wcp-lbl-audio');
    const capsBtnEl  = P.querySelector('#wcp-btn-opt-captions');
    const capsPanel  = P.querySelector('#wcp-panel-captions .wcp-subitem-list');
    const capStyleEntry = P.querySelector('#wcp-btn-caption-style');
    const capsLbl    = P.querySelector('#wcp-lbl-captions');

    // Remembered dub / subtitle choice — the SAME storage keys the in-page
    // player uses, so a choice made in either place carries over to the
    // other, to later parts of a split episode, and to the next episode.
    // wcoSubsPref: 'default' = leave the stream default, null = Off.
    let preferredAudio = null, preferredSubs = 'default';
    chrome.storage.local.get({ wcoAudioPref: null, wcoSubsPref: 'default' }, r => {
      preferredAudio = r.wcoAudioPref; preferredSubs = r.wcoSubsPref;
      populateHlsMenus();
    });
    const trackMatch = (list, pref) => {
      if (!pref || !list) return -1;
      let i = pref.name ? list.findIndex(t => t.name === pref.name) : -1;
      if (i < 0 && pref.lang) i = list.findIndex(t => t.lang === pref.lang);
      return i;
    };
    const applyPreferredTracks = () => {
      const ai = trackMatch(hls.audioTracks, preferredAudio);
      if (ai >= 0 && ai !== hls.audioTrack) hls.audioTrack = ai;
      if (preferredSubs === null) { if (hls.subtitleTrack !== -1) hls.subtitleTrack = -1; }
      else if (preferredSubs && preferredSubs !== 'default') {
        const si = trackMatch(hls.subtitleTracks, preferredSubs);
        if (si >= 0 && si !== hls.subtitleTrack) { hls.subtitleTrack = si; hls.subtitleDisplay = true; }
      }
    };
    // Clear a panel's items (the header lives outside the list, untouched).
    const clearItems = panel => panel.querySelectorAll('.wcp-subitem').forEach(x => x.remove());

    function populateHlsMenus() {
      if (!hls) return;
      applyPreferredTracks();

      // Audio dubs — only worth showing a menu for if there's a choice.
      clearItems(audioPanel);
      if (hls.audioTracks && hls.audioTracks.length > 1) {
        audioBtnEl.style.display = '';
        const activeIdx = hls.audioTrack;
        audioLbl.textContent = hls.audioTracks[activeIdx]?.name || hls.audioTracks[0]?.name || '—';
        hls.audioTracks.forEach((t, i) => {
          const item = document.createElement('div');
          item.className = 'wcp-subitem' + (i === activeIdx ? ' active' : '');
          item.textContent = t.name || t.lang || `Track ${i + 1}`;
          audioPanel.appendChild(item);
          item.addEventListener('click', e => {
            e.stopPropagation();
            hls.audioTrack = i;
            preferredAudio = { name: t.name || '', lang: t.lang || '' };
            chrome.storage.local.set({ wcoAudioPref: preferredAudio });
            audioPanel.querySelectorAll('.wcp-subitem').forEach(x => x.classList.remove('active'));
            item.classList.add('active');
            audioLbl.textContent = item.textContent;
            settingsMenu.classList.remove('open');
          });
        });
      } else {
        audioBtnEl.style.display = 'none';
      }

      // Captions/subtitles.
      clearItems(capsPanel);
      if (hls.subtitleTracks && hls.subtitleTracks.length > 0) {
        capsBtnEl.style.display = '';
        const offItem = document.createElement('div');
        offItem.className = 'wcp-subitem' + (hls.subtitleTrack < 0 ? ' active' : '');
        offItem.textContent = 'Off';
        capsPanel.appendChild(offItem);
        offItem.addEventListener('click', e => {
          e.stopPropagation();
          hls.subtitleTrack = -1;
          preferredSubs = null;
          chrome.storage.local.set({ wcoSubsPref: null });
          capsPanel.querySelectorAll('.wcp-subitem').forEach(x => x.classList.remove('active'));
          offItem.classList.add('active');
          capsLbl.textContent = 'Off';
          settingsMenu.classList.remove('open');
        });
        hls.subtitleTracks.forEach((t, i) => {
          const item = document.createElement('div');
          item.className = 'wcp-subitem' + (i === hls.subtitleTrack ? ' active' : '');
          item.textContent = t.name || t.lang || `Track ${i + 1}`;
          capsPanel.appendChild(item);
          item.addEventListener('click', e => {
            e.stopPropagation();
            hls.subtitleTrack = i;
            hls.subtitleDisplay = true;
            preferredSubs = { name: t.name || '', lang: t.lang || '' };
            chrome.storage.local.set({ wcoSubsPref: preferredSubs });
            capsPanel.querySelectorAll('.wcp-subitem').forEach(x => x.classList.remove('active'));
            item.classList.add('active');
            capsLbl.textContent = item.textContent;
            settingsMenu.classList.remove('open');
          });
        });
        capsLbl.textContent = hls.subtitleTrack >= 0 ? (hls.subtitleTracks[hls.subtitleTrack]?.name || 'On') : 'Off';
        if (capStyleEntry) capStyleEntry.style.display = ''; // "Captions settings" (appearance)
      } else {
        capsBtnEl.style.display = 'none';
        if (capStyleEntry) capStyleEntry.style.display = 'none';
      }

      // Real dub/caption choice on this episode → first-load hint bubble.
      if ((hls.audioTracks && hls.audioTracks.length > 1) || (hls.subtitleTracks && hls.subtitleTracks.length > 0)) {
        maybeShowTrackHint();
      }

      // Quality — HLS levels, switched locally via hls.currentLevel.
      // Overrides the (empty, for an HLS source) initData.qualities menu.
      if (hls.levels && hls.levels.length > 1) {
        clearItems(qualityPanel);
        const autoItem = document.createElement('div');
        autoItem.className = 'wcp-subitem' + (hls.currentLevel === -1 ? ' active' : '');
        autoItem.textContent = 'Auto';
        qualityPanel.appendChild(autoItem);
        autoItem.addEventListener('click', e => {
          e.stopPropagation();
          hls.currentLevel = -1;
          qualityPanel.querySelectorAll('.wcp-subitem').forEach(x => x.classList.remove('active'));
          autoItem.classList.add('active');
          qualityLbl.textContent = 'Auto';
          settingsMenu.classList.remove('open');
        });
        hls.levels.forEach((lvl, i) => {
          const label = lvl.height ? `${lvl.height}p` : `${Math.round((lvl.bitrate || 0) / 1000)}kbps`;
          const item = document.createElement('div');
          item.className = 'wcp-subitem' + (i === hls.currentLevel ? ' active' : '');
          item.textContent = label;
          qualityPanel.appendChild(item);
          item.addEventListener('click', e => {
            e.stopPropagation();
            hls.currentLevel = i;
            qualityPanel.querySelectorAll('.wcp-subitem').forEach(x => x.classList.remove('active'));
            item.classList.add('active');
            qualityLbl.textContent = label;
            settingsMenu.classList.remove('open');
          });
        });
        qualityLbl.textContent = hls.currentLevel === -1 ? 'Auto' : (qualityPanel.children[hls.currentLevel + 1]?.textContent || 'Auto');
      }
    }

    // ── Prev / Next episode arrows + pill — relayed to the source tab's
    // real parent-page navigation (episode list lives there). Re-checked
    // on every new episode (see refreshEpAvailability below) — checking
    // only once at startup meant these went stale after the first
    // transition (e.g. still showing a "next" arrow on the last episode).
    let nextAvailable = true, prevAvailable = true;
    const syncArrows = () => {
      epNextBtn.classList.toggle('wcp-ep-arrow-show', nextAvailable);
      epPrevBtn.classList.toggle('wcp-ep-arrow-show', prevAvailable);
    };
    const refreshEpAvailability = () => {
      chrome.tabs.sendMessage(sourceTabId, { type: 'WCO_CHECK_NEXT' }, res => { nextAvailable = !!res?.hasNext; syncArrows(); });
      chrome.tabs.sendMessage(sourceTabId, { type: 'WCO_CHECK_PREV' }, res => { prevAvailable = !!res?.hasPrev; syncArrows(); });
    };
    refreshEpAvailability();
    {
      const showEl = P.querySelector('#wcp-title-show');
      const metaEl = P.querySelector('#wcp-title-meta');
      if (showEl) showEl.textContent = initData.titleShow || '';
      if (metaEl) { metaEl.textContent = initData.titleMeta || ''; metaEl.style.display = initData.titleMeta ? '' : 'none'; }
    }

    // ── Self-sufficient episode navigation (safety net for a frozen tab) ──
    // Every episode change still goes through the source tab first, exactly
    // as before (it owns the real episode list, Random mode, etc.). What's
    // new is that the pop-out no longer waits indefinitely on it: the
    // moment navigation is requested (episode end, the Next pill, or the
    // prev/next arrows) the "Loading … episode" state shows and a fallback
    // timer is armed. If no confirmation arrives in time — a WCO_POPOUT_LOADING
    // (tab alive and navigating) or a sync carrying a NEW episode key —
    // chrome.tabs.update() loads the cached next/prev URL into the tab
    // directly, a browser-level action that works even while the tab's
    // own JS is frozen/throttled.
    //
    // Adaptive window, keyed off how recently the tab was last heard from
    // (lastSyncAt — refreshed by every WCO_POPOUT_SYNC heartbeat, which
    // arrives ~1/s while the tab is running):
    //   • heartbeat < 4s old  → tab is alive; a live tab answers within
    //     milliseconds, so 7s is a generous grace period before acting.
    //   • heartbeat ≥ 4s old  → tab is almost certainly frozen already
    //     (it's missed 4+ one-second beats); act after just 3.5s.
    // Both are far faster than the old flat 20s, and in the normal case
    // (tab responds promptly) the fallback is cancelled long before it fires,
    // so nothing looks or behaves differently from before.
    // (Random mode: a forced fallback can only use the sequential next URL.)
    const HEARTBEAT_FRESH_MS     = 4000;
    const NAV_FALLBACK_FRESH_MS  = 7000;
    const NAV_FALLBACK_STALE_MS  = 3500;
    const NAV_FORCED_GIVEUP_MS   = 30000; // after a forced load, never leave the UI locked forever
    let navPending = null;   // { dir, keyAtStart, url, wasPlaying, timer }
    let navGiveUpTimer = null;
    const navFallbackDelay = () =>
      (Date.now() - lastSyncAt) >= HEARTBEAT_FRESH_MS ? NAV_FALLBACK_STALE_MS : NAV_FALLBACK_FRESH_MS;
    const navLoadingText = dir => dir === 'prev' ? 'Loading previous episode…' : 'Loading next episode…';
    // Same loading state WCO_POPOUT_LOADING already uses: overlay + spinner,
    // bar forced visible but locked (fullscreen button still usable).
    const showNavLoading = (dir, sub) => {
      awaitingNewEpisode = true;
      vid.pause(); updatePlayIcon();
      bar.classList.add('wcp-locked');
      spinner.classList.add('on');
      setBoot(navLoadingText(dir), sub || 'Hang tight — switching episodes.', true);
    };
    const hideNavLoading = (resume) => {
      awaitingNewEpisode = false;
      bar.classList.remove('wcp-locked');
      spinner.classList.remove('on');
      setBoot('', '', false);
      if (resume) vid.play().then(updatePlayIcon).catch(updatePlayIcon);
    };
    // Cancel any pending fallback / give-up timers. Returns the direction
    // that was pending (if any) so callers can keep the right wording.
    const clearNavPending = () => {
      const dir = navPending?.dir || null;
      if (navPending) clearTimeout(navPending.timer);
      navPending = null;
      clearTimeout(navGiveUpTimer); navGiveUpTimer = null;
      return dir;
    };
    const armNavFallback = (dir) => {
      clearNavPending();
      // Only trust URLs cached for the episode that's actually playing.
      const url = navUrlsKey === lastKnownKey ? (dir === 'prev' ? cachedPrevEpisodeUrl : cachedNextEpisodeUrl) : null;
      const delay = navFallbackDelay();
      const pending = { dir, keyAtStart: lastKnownKey, url, wasPlaying: !vid.paused && !vid.ended, timer: null };
      showNavLoading(dir);
      pending.timer = setTimeout(() => {
        if (navPending !== pending) return;
        navPending = null;
        if (lastKnownKey !== pending.keyAtStart) return; // new episode already arrived
        if (!pending.url) {
          // Nothing to fall back to — don't leave the player stuck behind the overlay.
          log('No confirmation and no cached', dir, 'URL — releasing the loading state.');
          markStale('Reconnecting…');
          hideNavLoading(pending.wasPlaying);
          return;
        }
        log(`No confirmation after ${delay}ms — loading the ${dir} episode directly.`);
        markStale('Reconnecting…');
        setBoot(navLoadingText(dir), 'The original tab isn\'t responding — opening the episode directly…', true);
        try { chrome.tabs.update(sourceTabId, { url: pending.url }); } catch {}
        // From here the normal new-episode flow takes over (the reloaded tab
        // starts syncing on its own). Safety valve only:
        navGiveUpTimer = setTimeout(() => {
          navGiveUpTimer = null;
          if (lastKnownKey === pending.keyAtStart && awaitingNewEpisode) hideNavLoading(false);
        }, NAV_FORCED_GIVEUP_MS);
      }, delay);
      navPending = pending;
    };
    // Tab confirmed it's alive and navigating (WCO_POPOUT_LOADING): stand
    // the self-navigation down — the tab's own choice (e.g. Random) wins.
    const tabConfirmedNav = () => clearNavPending();

    epNextBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (navPending) return; // already on its way
      chrome.tabs.sendMessage(sourceTabId, { type: 'WCO_GO_NEXT' });
      armNavFallback('next');
    });
    epPrevBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (navPending) return;
      chrome.tabs.sendMessage(sourceTabId, { type: 'WCO_GO_PREV' });
      armNavFallback('prev');
    });

    let epKept = false;
    let epTriggered = false;
    let anchor = null; // declared here so resetEpisodeState() below can reach it

    // The ONE place that actually fires real navigation from the pop-out.
    // Routes through the site's own handleEnded() (via WCO_POPOUT_EPISODE_ENDED)
    // so Random mode still picks a genuine random episode, not just "next."
    //
    // This is also where the real fallback lives now — armed ONLY here,
    // in direct response to the episode genuinely ending, never just
    // because the heartbeat's been quiet for a while (that was the bug:
    // tying it to general staleness fired it during completely normal
    // background throttling, jumping episodes early with no relation to
    // actual playback position). After telling the site tab the episode
    // ended, this waits a reasonable window for confirmation — a
    // WCO_POPOUT_SYNC with a DIFFERENT videoSrc, meaning the tab
    // genuinely advanced. If that doesn't arrive in time (the tab may be
    // too throttled to even process the message, not just slow to
    // reply), chrome.tabs.update() forces the navigation directly — a
    // browser-level command that doesn't depend on the tab's own JS
    // running at all, unlike messaging.
    //
    // v1.0.39: the wait is no longer a flat 20s — it's the adaptive
    // armNavFallback() window above (7s if the tab was heard from in the
    // last 4s, 3.5s if it had already gone quiet), and the "Loading next
    // episode…" state now shows immediately while waiting.
    const triggerEpEnded = () => {
      if (epTriggered) return;
      epTriggered = true;
      epWrap.classList.remove('wcp-vis');
      const keyAtEnd = lastKnownKey;
      chrome.tabs.sendMessage(sourceTabId, { type: 'WCO_POPOUT_EPISODE_ENDED' });
      chrome.storage.local.get({ navMode: 'next' }, p => {
        // Autoplay off / last episode: the tab won't navigate either — nothing to wait for.
        if (p.navMode === 'off' || !nextAvailable) return;
        if (lastKnownKey !== keyAtEnd) return;           // already advanced
        if (awaitingNewEpisode || navPending) return;    // tab already confirmed (LOADING) / already armed
        armNavFallback('next');
      });
    };

    // Bug fix: epTriggered/epKept/anchor were never reset after the FIRST
    // episode ended. Since this pop-out player is only ever built ONCE
    // (later episodes just swap vid.src via sync, they don't rebuild the
    // whole player), that "already triggered" guard stayed permanently
    // true for the rest of the session — silently blocking BOTH the
    // countdown AND the "Next Episode" pill button (both go through
    // triggerEpEnded()) on every episode after the first. The top
    // prev/next arrow buttons bypass triggerEpEnded() entirely (they
    // message the source tab directly), which is exactly why those kept
    // working while everything routed through here quietly stopped.
    const resetEpisodeState = () => {
      epTriggered = false;
      epKept = false;
      anchor = null;
    };

    keepBtn.addEventListener('click', e => { e.stopPropagation(); epKept = true; epWrap.classList.remove('wcp-vis'); });
    nextBtn.addEventListener('click', e => { e.stopPropagation(); epKept = false; triggerEpEnded(); });
    // A non-final part ending rolls straight into the next part (locally,
    // no pill); only the LAST part's end advances the episode.
    vid.addEventListener('ended', () => {
      if (parts && !pendingSwap && partIdx < parts.length - 1) {
        loadPart(partIdx + 1, 0, true);
        sendCommand('seek', offsets[partIdx]); // keep the dormant tab copy roughly aligned for pop-back-in
        return;
      }
      triggerEpEnded();
    });

    // Same computation as the site's player, exactly — including the
    // "Show prompt at" advanced setting (leadMode/leadTimeCustom), which
    // this was previously ignoring entirely (always used a hardcoded 10s
    // threshold instead), making the pop-out inconsistent with whatever
    // was actually configured in the extension popup.
    //
    // Critically, this is also now the ONLY thing that can actually fire
    // auto-advance while handed off: the site's own video is paused the
    // whole time it's in the background, so ITS timeupdate-driven
    // countdown never ticks and can never reach zero on its own. Before
    // this fix the pop-out's countdown badge was purely decorative — it
    // counted down visually but never actually triggered anything.
    // Read prefs FRESH on every tick, matching the site's player exactly —
    // previously this read chrome.storage ONCE when the pop-out first
    // connected and cached that snapshot for the rest of the session
    // (since buildPlayer() only ever runs once here; episode transitions
    // just swap the video src, they don't re-run this setup). That meant
    // changing "Next Episode Timing" in the popup while the pop-out was
    // already open silently had no effect — not even across later
    // episodes — until the pop-out was closed and reopened entirely.
    vid.addEventListener('timeupdate', async () => {
      if (pendingSwap) return; // mid part-swap: <video> briefly reports the new part at 0s
      if (!totalDur() || epKept || !nextAvailable) { epWrap.classList.remove('wcp-vis'); return; }
      const prefs = await new Promise(resolve =>
        chrome.storage.local.get({ navMode: 'next', countdownDuration: 10, leadMode: 'disabled', leadTimeCustom: 60 }, resolve)
      );
      if (prefs.navMode === 'off') { epWrap.classList.remove('wcp-vis'); return; }
      pillText.textContent = prefs.navMode === 'random' ? 'Random Episode' : 'Next Episode';
      if (pendingSwap) return;
      const rem = totalDur() - curT(); // whole-episode remaining (all parts)
      const cd  = prefs.countdownDuration || 0;

      // "Disabled" lead mode mirrors the countdown time exactly — no
      // extra early heads-up. "Custom" shows the pill this many seconds
      // ahead of the real end instead.
      const lead = prefs.leadMode === 'custom'
        ? (prefs.leadTimeCustom || 60)
        : (cd || 0);

      if (rem <= lead && rem > 0) {
        epWrap.classList.add('wcp-vis');
        if (!cd) {
          // Disabled countdown: badge shows actual seconds remaining,
          // navigation fires only once the video truly ends (via the
          // 'ended' listener above).
          pillTimer.textContent = Math.ceil(rem);
        } else {
          if (anchor === null) anchor = curT();
          let elapsed = curT() - anchor;
          if (elapsed < 0) { anchor = curT(); elapsed = 0; }
          const left = Math.min(cd, Math.ceil(cd - elapsed));
          if (left <= 0) { triggerEpEnded(); return; }
          pillTimer.textContent = left;
        }
      } else if (rem <= 0) {
        triggerEpEnded();
      } else {
        epWrap.classList.remove('wcp-vis');
        anchor = null;
      }
    });

    // ── Keyboard shortcuts ───────────────────────────────────────────────
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space')      { e.preventDefault(); togglePlay(); }
      if (e.code === 'ArrowLeft')  seekCombined(curT() - 5);
      if (e.code === 'ArrowRight') seekCombined(Math.min(totalDur() || 0, curT() + 5));
      if (e.code === 'KeyF')       { isFS() ? exitFS() : reqFS(P); }
      if (e.code === 'KeyM')       { vid.muted = !vid.muted; sendCommand('toggleMute'); }
    });

    // Re-sync the icon after play() actually settles (it's async) instead
    // of trusting vid.paused at the moment right after calling it — that
    // race was why the play/pause icon sometimes didn't reflect reality.
    // Attach the first source (merged parts or a single video) now that
    // every helper exists, then start playback.
    startEpisode(initData);
    vid.play().then(updatePlayIcon).catch(updatePlayIcon);
    if (initData.paused) { vid.pause(); updatePlayIcon(); }
    updatePlayIcon();

    const setTitle = (show, meta) => {
      const showEl = P.querySelector('#wcp-title-show');
      const metaEl = P.querySelector('#wcp-title-meta');
      if (showEl) showEl.textContent = show || '';
      if (metaEl) { metaEl.textContent = meta || ''; metaEl.style.display = meta ? '' : 'none'; }
    };
    return { P, vid, updatePlayIcon, updateVolIcon, refreshEpAvailability, resetEpisodeState, setTitle, populateHlsMenus,
             startEpisode, adoptParts, clearNavPending, tabConfirmedNav, navLoadingText };
  };

  // ── Sync updates from the source tab (heartbeat + loading state) ────────
  // Episode identity. The embed sends a stable `episodeKey` (its first
  // part's original src) so part swaps and quality changes WITHIN one
  // episode are never mistaken for a new episode; falls back to videoSrc
  // for anything that doesn't send one.
  let lastKnownKey = null;
  const keyOf = d => d?.episodeKey || d?.videoSrc || null;
  let awaitingNewEpisode = false;
  let cachedNextEpisodeUrl = null; // used to seed the dedicated episode-end fallback below
  let cachedPrevEpisodeUrl = null; // same, for the "previous episode" arrow's fallback
  // Which episode those two URLs were computed for. Reset whenever a
  // message for a DIFFERENT episode arrives, so a fallback can never use
  // the previous episode's "next" URL (= the episode now playing).
  let navUrlsKey = null;
  const cacheNavUrls = d => {
    if (!d) return;
    const k = keyOf(d);
    if (k && k !== navUrlsKey) { navUrlsKey = k; cachedNextEpisodeUrl = null; cachedPrevEpisodeUrl = null; }
    if (d.nextEpisodeUrl) cachedNextEpisodeUrl = d.nextEpisodeUrl;
    if (d.prevEpisodeUrl) cachedPrevEpisodeUrl = d.prevEpisodeUrl;
  };
  // A genuinely new episode arrived (sync heartbeat, resync click, or the
  // watchdog's retry) — swap it in and clear every transition state.
  const adoptNewEpisode = (data) => {
    lastKnownKey = keyOf(data);
    cacheNavUrls(data);
    awaitingNewEpisode = false;
    if (!player) return;
    player.clearNavPending();
    player.startEpisode(data);
    player.P.querySelector('#wcp-bar')?.classList.remove('wcp-locked'); // this IS the new episode now
    player.P.querySelector('#wcp-spinner')?.classList.remove('on');
    player.vid.play().then(player.updatePlayIcon).catch(player.updatePlayIcon);
    player.refreshEpAvailability(); // re-check next/prev for the new episode
    player.resetEpisodeState(); // clear the "already triggered" guard from the last episode
    setBoot('', '', false); // clear the loading overlay now that content arrived
  };

  // ── Sync watchdog ─────────────────────────────────────────────────────
  // The source tab sends a heartbeat roughly once a second while active.
  // If that stops arriving for a while, it's almost always because that
  // tab got throttled in the background (browsers do this to hidden
  // tabs) — not because anything actually broke. Rather than fail
  // silently, show it, and keep gently trying to re-establish contact so
  // this recovers on its own the moment that tab gets a chance to run
  // again, without needing to close and reopen this whole window.
  //
  // IMPORTANT: this watchdog only retries via messaging — it does NOT
  // force a navigation on its own. An earlier version tied a
  // chrome.tabs.update() fallback directly to "no heartbeat in 60s,"
  // which was a real bug: going quiet for a while is completely normal
  // and expected while the source tab is backgrounded (that's the
  // WHOLE point of the pop-out), and has nothing to do with whether the
  // current episode has actually ended. That caused episodes to jump
  // early — sometimes just a couple minutes in — purely because the tab
  // got throttled quickly, with no relation to actual playback position.
  // The real fallback now lives with triggerEpEnded() instead, where it
  // belongs: it only ever arms once we already know the episode should
  // be advancing, never just because the tab's been quiet for a while.
  const syncBadge     = document.getElementById('wcp-syncbadge');
  const syncBadgeText = document.getElementById('wcp-syncbadge-text');
  // lastSyncAt doubles as the "last heard from the tab" heartbeat
  // timestamp that the adaptive navigation fallback reads (see
  // armNavFallback() inside buildPlayer).
  let lastSyncAt = Date.now();
  const STALE_AFTER_MS = 15000; // no heartbeat in 15s = likely throttled — start retrying via messaging

  const markSynced = () => {
    lastSyncAt = Date.now();
    syncBadge.classList.remove('stale');
    syncBadgeText.textContent = 'Synced';
  };
  const markStale = (text) => {
    syncBadge.classList.add('show', 'stale');
    syncBadgeText.textContent = text || 'Reconnecting…';
  };

  syncBadge.addEventListener('click', () => {
    if (!syncBadge.classList.contains('stale')) return;
    requestInit().then(data => {
      if (data?.videoSrc) {
        markSynced();
        cacheNavUrls(data);
        if (data.titleShow && player) player.setTitle(data.titleShow, data.titleMeta);
        if (keyOf(data) !== lastKnownKey) adoptNewEpisode(data);
      }
    });
  });

  setInterval(() => {
    if (!player) return; // nothing to keep in sync with yet
    const staleFor = Date.now() - lastSyncAt;

    if (staleFor <= STALE_AFTER_MS) {
      syncBadge.classList.add('show');
      setTimeout(() => { if (!syncBadge.classList.contains('stale')) syncBadge.classList.remove('show'); }, 2000);
      return;
    }

    markStale();
    // Retry via messaging only — this succeeds the instant the source
    // tab gets a chance to actually run again, no user action required.
    // Deliberately does NOT escalate to forcing a navigation on its own;
    // see the comment above for why that was wrong.
    chrome.tabs.sendMessage(sourceTabId, { type: 'WCO_POPOUT_INIT_REQUEST' }, (res) => {
      if (res?.videoSrc) {
        markSynced();
        cacheNavUrls(res);
        if (res.titleShow && player) player.setTitle(res.titleShow, res.titleMeta);
        if (player && keyOf(res) === lastKnownKey && res.parts) player.adoptParts(res.parts);
        // Reconnected onto a DIFFERENT episode while we were waiting on a
        // transition (e.g. after a forced fallback load) — adopt it now.
        else if (player && awaitingNewEpisode && keyOf(res) !== lastKnownKey) adoptNewEpisode(res);
      }
    });
  }, 5000);

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!sourceTabId || sender?.tab?.id !== sourceTabId) return;

    // Full connecting/loading overlay reinstated for episode transitions —
    // it doubles as a "refresh point" for the UI (arrows, pills, quality
    // list all get re-checked once the new episode actually arrives).
    //
    // Two things happen together during a transition: the loading overlay
    // shows (reparented inside #wcp so it survives fullscreen — see the
    // P.appendChild(bootEl) comment above), and the control bar is forced
    // visible with everything in it grayed out and inert EXCEPT the
    // fullscreen button — so the user can always back out of fullscreen
    // instead of feeling stuck there while the next episode loads in.
    if (msg?.type === 'WCO_POPOUT_LOADING') {
      markSynced();
      awaitingNewEpisode = true;
      // Tab is alive and navigating itself — stand down the pop-out's own
      // fallback (keeping "previous" wording if that's what was clicked).
      const pendingDir = player ? player.tabConfirmedNav() : null;
      if (player) {
        player.vid.pause();
        player.P.querySelector('#wcp-bar')?.classList.add('wcp-locked');
        player.P.querySelector('#wcp-spinner')?.classList.add('on');
      }
      setBoot(pendingDir === 'prev' ? 'Loading previous episode…' : 'Loading next episode…',
              pendingDir === 'prev' ? 'Hang tight — the tab is switching to the previous episode.'
                                    : 'Hang tight — the tab is switching to the next episode.', true);
      return;
    }

    if (msg?.type === 'WCO_POPOUT_SYNC') {
      markSynced(); // = heartbeat timestamp (lastSyncAt) for the adaptive nav fallback
      cacheNavUrls(msg);
      if (!player) return; // not built yet — requestInit() flow handles first load
      const { videoSrc, currentTime, volume, muted, titleShow, titleMeta, isHls } = msg;
      const vid = player.vid;

      if (titleShow) player.setTitle(titleShow, titleMeta);

      // Note: "paused" is intentionally not part of this message — the
      // source tab is always paused while handed off, so it's not
      // meaningful playback info. The pop-out owns real play/pause state
      // itself, driven by its own controls.
      //
      // currentTime is ONLY used to seed a genuinely NEW episode's
      // starting position — never for ongoing drift-correction. The
      // source's video is paused (frozen) the whole time it's handed
      // off, so treating its currentTime as a moving "correct" target
      // was exactly what caused the pop-out to keep snapping backward
      // and replaying the same 1-2 seconds once it played past it.
      //
      // Split episodes: a NEW episode starts on whatever part/local time
      // the tab reports (startEpisode). For the SAME episode, the part
      // list is adopted in place the first time it shows up (the tab
      // builds its merged timeline a few seconds after load) — after
      // that, part-to-part progress is driven locally here, never by
      // these (frozen) heartbeats.
      if (videoSrc && keyOf(msg) !== lastKnownKey) {
        adoptNewEpisode(msg); // also hides any "Loading … episode" state + cancels the fallback
      }
      else if (msg.parts) player.adoptParts(msg.parts);
      // No ongoing time-sync here on purpose — see note above.
    }
  });

  // ── Disconnect detection ────────────────────────────────────────────────
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === sourceTabId) {
      setBoot('Tab closed', 'The original tab was closed. Playback here will continue, but episode navigation and sync are no longer available.', true);
      setTimeout(() => setBoot('', '', false), 4000);
    }
  });

  window.addEventListener('beforeunload', () => {
    try { chrome.runtime.sendMessage({ type: 'WCO_POPOUT_CLOSING' }); } catch {}
  });

  // ── Boot ──────────────────────────────────────────────────────────────
  ready.then(async () => {
    if (!sourceTabId) return;
    setBoot('Connecting…', 'Waiting for the video in the original tab.');
    let data = null;
    for (let i = 0; i < 30 && !data?.videoSrc; i++) {
      data = await requestInit();
      if (!data?.videoSrc) await new Promise(r => setTimeout(r, 500));
    }
    if (!data?.videoSrc) { setBoot('Couldn\'t reach the player', 'Make sure the original tab still has a video open, then reopen this window.'); return; }

    lastKnownKey = keyOf(data);
    cacheNavUrls(data);
    player = buildPlayer(data);
    setBoot('', '', false);
  });
})();
