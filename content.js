/* =================================================================
   WCO Suite – content.js v7.0 (VJS v10 UI + Quality via VJS + FS restore)

   FIXES:
     • Auto-Close restored: Restored independent watchClose() observer with full 15s fallback window.
     • 10s Seek Icons: Corrected backward (<) and forward (>) arrow arc orientations.
     • Quality Switcher Fix: Scrapes page inline <script> tags for tokenized 'vhd' / 'vsd'
       URLs to bypass content-script isolated-world limitations.
     • VideoJS v10 UI: Retained official V10 glass dock, settings menu, hotkeys, and PiP.
================================================================= */
(() => {
  'use strict';

  const q     = (s, r = document) => r.querySelector(s);
  const qa    = (s, r = document) => [...r.querySelectorAll(s)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm  = u => { try { return new URL(u, location.href).href.replace(/\/+$/, ''); } catch { return String(u).replace(/\/+$/, ''); } };
  const sameURL = (a, b) => norm(a) === norm(b);
  const log   = (...a) => console.log('[WCO-V10]', ...a);

  const isFS = () => !!(document.fullscreenElement || document.webkitFullscreenElement ||
                        document.mozFullScreenElement || document.msFullscreenElement);
  const reqFS = el => {
    if (!el) return;
    (el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen
    )?.call(el);
  };
  const exitFS = () => (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);

  const getPrefs = () => new Promise(r => chrome.storage.local.get({
    navMode:        'next',  // 'next' | 'random' | 'off'  — same role as YouTube's autoplay toggle
    volume:         1,       // remembered volume level (0–1)
    muted:          false,   // remembered mute state
    wantsFS:        false,   // "was in fullscreen last time" flag — fires on next real gesture
    autoFullscreen: false,   // master toggle: is the auto-fullscreen feature on at all? (off by default)
    leadMode:       'disabled', // 'disabled' | 'custom' — extension-only "advanced" setting.
                                 // 'disabled' makes the pill appear exactly when the countdown
                                 // would start (mirrors countdownDuration); 'custom' shows it
                                 // earlier, using leadTimeCustom seconds before the real end.
    leadTimeCustom: 60,      // used only when leadMode === 'custom'
    countdownDuration: 10,   // 0 (Disabled) | 5 | 10 | 15 — real-time countdown that fires
                              // navigation early, independent of the video's actual remaining time.
                              // 0/Disabled falls back to the old behavior: wait for the true video end.
  }, r));
  const setPref = (k, v) => chrome.storage.local.set({ [k]: v });
  const FS_KEY = 'wco_was_fs';


  // ══════════════════════════════════════════════════════════════════════════
  //  EMBED PLAYER (embed.wcostream.com + vhs.wcostream.com)
  //
  //  Both player hosts run through the SAME buildPlayer() code path. The
  //  only differences for VHS are (a) where the real source comes from
  //  (the saturn .m3u8 URL in the page's inline script, fed to hls.js,
  //  instead of the VJS <video>'s progressive src) and (b) the settings
  //  menu gets Audio / Captions / Quality from hls.js directly.
  // ══════════════════════════════════════════════════════════════════════════
  const HOST    = location.hostname.replace(/^www\./, '');
  const isVhs   = HOST === 'vhs.wcostream.com';
  const isEmbed = HOST === 'embed.wcostream.com';
  if (isEmbed || isVhs) {

    // VHS has two stages inside the same iframe: an announcement page with
    // a #close-btn countdown (no video), which then location.replace()s
    // itself to /video-js/ — the real VideoJS player page.
    const isVhsPlayerPage = isVhs && /^\/video-js\//.test(location.pathname);

    // ── Split-episode role ─────────────────────────────────────────────────
    // The parent page names every 2nd+ part iframe "wco-part-N" the moment
    // the iframe element is inserted (before it has even loaded). A named
    // secondary part never builds a player and never plays — it only
    // reports its resolved source to the parent, which then removes it.
    const partRoleIdx = () => { const m = /^wco-part-(\d+)$/.exec(window.name || ''); return m ? parseInt(m[1], 10) : 0; };
    const isSecondaryPart = () => partRoleIdx() > 0;

    // ── VHS saturn URL extraction ──────────────────────────────────────────
    // The VHS <video> ends up with an unusable MSE blob: URL. The real HLS
    // source is the saturn getvid .../index.m3u8 URL that the page's inline
    // script hands to getRedirectedUrl(); a commented-out <source> tag in
    // #hls carries the same URL and is used as a fallback.
    const SATURN_RE = /getRedirectedUrl\(\s*["'](https:\/\/saturn\.wcostream\.com\/[^"']+)["']/;
    const SATURN_SRC_RE = /["'](https:\/\/saturn\.wcostream\.com\/getvid\/[^"']+?\.m3u8[^"']*)["']/;
    const extractSaturnFromText = txt => {
      const m = SATURN_RE.exec(txt || '') || SATURN_SRC_RE.exec(txt || '');
      return m ? m[1] : null;
    };
    const extractSaturnUrl = () => {
      for (const s of qa('script:not([src])')) {
        const u = extractSaturnFromText(s.textContent);
        if (u) return u;
      }
      const hlsBox = q('#hls');
      return hlsBox ? extractSaturnFromText(hlsBox.innerHTML) : null;
    };
    const absUrl = u => { try { return u ? new URL(u, location.href).href : ''; } catch { return u || ''; } };
    const vhsPoster = () => absUrl(
      q('#hls')?.getAttribute('poster') || q('#hls_html5_api')?.getAttribute('poster') ||
      q('.vjs-poster img')?.getAttribute('src') || ''
    );

    // Keep the site's own (hidden) VideoJS <video> permanently silent and
    // paused — our own <video> is the only thing that should ever play.
    const silenceNative = v => {
      if (!v || v.__wcoSilenced) return;
      v.__wcoSilenced = true;
      const hush = () => { try { v.muted = true; v.pause(); } catch {} };
      hush();
      v.addEventListener('play', hush);
      v.addEventListener('playing', hush);
      v.__wcoUnsilence = () => {
        v.removeEventListener('play', hush);
        v.removeEventListener('playing', hush);
        v.__wcoSilenced = false;
        try { v.muted = false; } catch {}
      };
    };

    const reportPartSrc = info => {
      try { parent.postMessage({ type: 'WCO_PART_SRC', ...info }, '*'); } catch {}
    };

    let closeFired = false;
    let closePromise = null;

    // Helper: Observes overlay delay countdown button & clicks when enabled
    const watchClose = () => {
      if (closePromise) return closePromise;
      closePromise = new Promise(resolve => {
        const handle = btn => {
          if (closeFired) return resolve();
          let obs, fb;
          const click = () => {
            if (closeFired) return;
            closeFired = true;
            obs?.disconnect();
            clearTimeout(fb);
            try { btn.click(); } catch {}
            log('close-btn clicked');
            resolve();
          };
          fb = setTimeout(() => { try { btn.removeAttribute('disabled'); } catch {} click(); }, 15000);
          obs = new MutationObserver(() => { if (!btn.hasAttribute('disabled')) click(); });
          obs.observe(btn, { attributes: true, attributeFilter: ['disabled'] });
          if (!btn.hasAttribute('disabled')) click();
        };

        const btn = q('#close-btn');
        if (btn) { handle(btn); return; }

        const obs = new MutationObserver(() => {
          const b = q('#close-btn');
          if (b && !closeFired) { obs.disconnect(); handle(b); }
        });
        obs.observe(document.documentElement, { childList: true, subtree: true });

        // Safety timeout fallback (15 seconds)
        setTimeout(() => {
          if (!closeFired) {
            obs.disconnect();
            resolve();
          }
        }, 15000);
      });
      return closePromise;
    };

    // Read quality options from the VJS quality dropdown.
    // The VJS plugin already has the resolved signed URLs — we just read them
    // after clicking the hidden dropdown item and waiting for VJS to update its src.
    const readVJSQualities = () => {
      const items = qa('.vjs-quality-dropdown li[data-code]');
      return items.map(li => ({
        code:  li.dataset.code,                          // hd1080 / hd720 / hd576
        label: { hd1080:'FHD', hd720:'HD', hd576:'SD' }[li.dataset.code] || li.dataset.code,
        li
      }));
    };

    // Click a VJS quality item, wait for VJS to update video.src, return new src.
    const resolveVJSSrc = (vjsVideo, li) => new Promise(resolve => {
      const prev = vjsVideo.src;
      const a = li.querySelector('a');
      if (!a) return resolve(prev);
      a.click();
      // VJS updates src asynchronously — poll for up to 3s
      let tries = 0;
      const poll = setInterval(() => {
        if (vjsVideo.src !== prev || ++tries > 30) {
          clearInterval(poll);
          resolve(vjsVideo.src || prev);
        }
      }, 100);
    });

    // ── Source discovery (shared by the player and harvest mode) ──────────
    // Returns { vjsVideo, src, poster, isHls } or null.
    const findSource = async () => {
      let vjsVideo = null;
      if (isVhs) {
        let saturn = null;
        // Tight 50ms poll for the first ~2s, then back off to 150ms.
        for (let i = 0; i < 220 && !(vjsVideo && saturn); i++) {
          vjsVideo = vjsVideo || q('#hls_html5_api') || q('video.vjs-tech') || q('video');
          saturn   = saturn || extractSaturnUrl();
          if (!(vjsVideo && saturn)) await sleep(i < 40 ? 50 : 150);
        }
        if (!saturn) { log('VHS: could not find saturn .m3u8 URL'); return null; }
        silenceNative(vjsVideo);
        return { vjsVideo, src: saturn, poster: vhsPoster(), isHls: true };
      }
      for (let i = 0; i < 220; i++) {
        vjsVideo = q('video.vjs-tech') || q('video');
        if (vjsVideo && vjsVideo.src && vjsVideo.src.includes('getvid')) break;
        await sleep(i < 40 ? 50 : 150);
      }
      if (!vjsVideo || !vjsVideo.src) { log('Could not locate video stream source.'); return null; }
      return { vjsVideo, src: vjsVideo.src, poster: vjsVideo.poster || vjsVideo.getAttribute('poster') || '', isHls: false };
    };

    // ── Harvest mode (secondary split-part iframes only) ──────────────────
    // No player, no playback. Resolve this part's real source, report it
    // to the parent (repeated until the parent removes this iframe, which
    // it does as soon as it has every part), and nothing else.
    const runHarvest = async () => {
      log('[split] secondary part', partRoleIdx(), '— harvest mode (no player)');
      let info = null;
      if (isVhs && !isVhsPlayerPage) {
        // Announcement page: try reading the /video-js/ page directly
        // (same origin) so we don't have to sit through the countdown.
        try {
          const html = await (await fetch('/video-js/' + location.search, { credentials: 'include' })).text();
          const src = extractSaturnFromText(html);
          if (src) info = { src, poster: '', isHls: true };
        } catch {}
        // Otherwise let the countdown finish; the page navigates itself to
        // /video-js/, where this script runs again and harvests there.
        if (!info) { watchClose(); return; }
      } else {
        if (isEmbed) watchClose();
        const found = await findSource();
        if (!found) return;
        silenceNative(found.vjsVideo);
        info = { src: found.src, poster: found.poster, isHls: found.isHls };
      }
      for (let i = 0; i < 60; i++) { reportPartSrc(info); await sleep(1000); }
    };

    const buildPlayer = async () => {
      const found = await findSource();
      if (!found) return;
      const vjsVideo = found.vjsVideo;
      const videoSrc = found.src;          // stable per page load — also the pop-out's episode key
      const poster   = found.poster;
      const srcIsHls = found.isHls;        // true on VHS (hls.js), false on the standard embed

      // Ask the parent page whether there's genuinely a next/previous
      // episode. Defaults optimistic (true) until each reply arrives.
      // NOTE: #wcp isn't in the DOM yet at this point in buildPlayer, so
      // the arrow buttons are queried fresh (not cached) wherever used.
      let nextEpisodeAvailable = true;
      let prevEpisodeAvailable = true;
      let episodeShow = '';
      let episodeMeta = '';
      let cachedNextEpisodeUrl = null; // last-resort fallback if live sync stalls — see pop-out watchdog
      let cachedPrevEpisodeUrl = null; // same, for the pop-out's "previous episode" button
      const syncEpArrows = () => {
        q('#wcp-ep-next')?.classList.toggle('wcp-ep-arrow-show', nextEpisodeAvailable);
        q('#wcp-ep-prev')?.classList.toggle('wcp-ep-arrow-show', prevEpisodeAvailable);
      };
      const applyTitleToDom = () => {
        const showEl = q('#wcp-title-show');
        const metaEl = q('#wcp-title-meta');
        if (showEl) showEl.textContent = episodeShow;
        if (metaEl) { metaEl.textContent = episodeMeta; metaEl.style.display = episodeMeta ? '' : 'none'; }
      };
      window.addEventListener('message', e => {
        if (e?.data?.type === 'WCO_NEXT_INFO') { nextEpisodeAvailable = !!e.data.hasNext; syncEpArrows(); }
        if (e?.data?.type === 'WCO_PREV_INFO') { prevEpisodeAvailable = !!e.data.hasPrev; syncEpArrows(); }
        if (e?.data?.type === 'WCO_TITLE_INFO') {
          episodeShow = e.data.show || '';
          episodeMeta = e.data.meta || '';
          applyTitleToDom();
        }
        if (e?.data?.type === 'WCO_NEXT_URL_INFO') {
          cachedNextEpisodeUrl = e.data.url || null;
          cachedPrevEpisodeUrl = e.data.prevUrl || null;
        }
        // Split episode: the parent hands us every part's source, in order.
        if (e?.data?.type === 'WCO_MERGE_PARTS' && e.source === parent && Array.isArray(e.data.parts)) {
          if (onMergeParts) onMergeParts(e.data.parts); else queuedMergeParts = e.data.parts;
        }
      });
      let onMergeParts = null, queuedMergeParts = null;
      try { parent.postMessage({ type: 'WCO_CHECK_NEXT' }, '*'); } catch {}
      try { parent.postMessage({ type: 'WCO_CHECK_PREV' }, '*'); } catch {}
      try { parent.postMessage({ type: 'WCO_GET_TITLE' }, '*'); } catch {}
      try { parent.postMessage({ type: 'WCO_GET_NEXT_URL' }, '*'); } catch {}

      // Quality items read lazily when panel opens (VJS quality selector
      // populates the dropdown after an async AJAX call, so it may not
      // exist yet when buildPlayer first runs).
      let qualitiesLoaded = false;

      // Hide default player container
      // VHS: the VJS box sits in bootstrap rows that collapse to 0 height
      // once hidden, so our player is a fixed overlay over the whole iframe
      // viewport instead (the iframe itself IS the player area).
      const vjsContainer = q('#video-js') || q('.video-js');
      const playerWrap   = isVhs ? document.body
        : (q('.player-16x9') || q('.player-with-overlay') || vjsContainer?.parentElement);
      if (vjsContainer) vjsContainer.style.display = 'none';
      if (isVhs) {
        document.documentElement.style.overflow = 'hidden';
        document.body.style.overflow = 'hidden';
      }

      // ── Clean up leftover site UI that sits ON TOP of the player area ──
      // Things like a "Chromecast Player (2. Player)" alt-player tab, or a
      // floating cast/mini-player icon, are often placed as siblings inside
      // the same wrapper rather than inside #video-js — so hiding the VJS
      // container alone doesn't remove them. We hide anything by matching
      // text/class rather than an exact selector, since site markup varies.
      const CAST_TEXT_RE = /chromecast|2\.\s*player|player\s*2/i;
      const CAST_CLASS_RE = /cast|chromecast|miniplayer|mini-player/i;

      const sweepClutter = (root) => {
        if (!root) return;
        qa('*', root).forEach(el => {
          if (el.closest('#wcp')) return; // never touch our own player
          const txt = (el.childNodes.length && el.children.length === 0)
            ? (el.textContent || '').trim() : '';
          const cls = (el.className && typeof el.className === 'string') ? el.className : '';
          const id  = el.id || '';
          if (CAST_TEXT_RE.test(txt) || CAST_CLASS_RE.test(cls) || CAST_CLASS_RE.test(id)) {
            // Hide the smallest sensible wrapper: the element itself if it's
            // already a link/button/div, otherwise its parent.
            const target = ['A','BUTTON','DIV','SPAN'].includes(el.tagName) ? el : el.parentElement;
            if (target) target.style.setProperty('display', 'none', 'important');
          }
        });
      };

      // Sweep once now, then keep watching — some of these badges are
      // injected slightly after the initial page load.
      // (Not needed on VHS: our fixed overlay covers the entire iframe.)
      if (!isVhs) {
        sweepClutter(playerWrap || document.body);
        new MutationObserver(() => sweepClutter(playerWrap || document.body))
          .observe(playerWrap || document.body, { childList: true, subtree: true });
      }

      // ── VideoJS v10 CSS Styles ───────────────────────────────────────────
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

        /* Split-episode chapter boundaries on the ONE combined scrubber */
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

        /* Fullscreen title overlay — small "S1:E2 - Episode Title" line
           above the larger, bolder show name, matching how streaming
           platforms lay this out. Shown only in fullscreen here (the
           windowed site already shows the title on the page itself, so
           this would be redundant there). */
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
        #wcp.wcp-ui.wcp-is-fullscreen #wcp-title-overlay { opacity: 1; }

      `;
      document.head.appendChild(style);

      // ── Build Custom Player Container ────────────────────────────────────
      if (playerWrap) playerWrap.style.position = 'relative';

      // ── Caption appearance options (mirrors VideoJS's own "captions
      // settings" dialog option sets exactly). Same table lives in
      // popout-player.js; both read/write chrome.storage 'wcoCaptionAppearance'.
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
            <div class="wcp-menu-item" id="wcp-btn-opt-autofs" title="Tries to re-enter fullscreen on your first tap after an episode loads. For a more reliable fullscreen experience across episodes, use the pop-out window (icon in this bar) instead.">
              <div class="wcp-menu-left">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
                <span>In-page Fullscreen</span>
              </div>
              <div class="wcp-menu-right">
                <span id="wcp-lbl-autofs">On</span>
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
            <!-- Quality items injected by JS after reading VJS dropdown (or hls.js levels on VHS) -->
            <div class="wcp-subitem-list"></div>
          </div>

          <div class="wcp-menu-panel" id="wcp-panel-audio">
            <div class="wcp-menu-header" id="wcp-audio-back">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
              <span>Audio</span>
            </div>
            <div class="wcp-subitem-list"></div>
          </div>

          <div class="wcp-menu-panel" id="wcp-panel-captions">
            <div class="wcp-menu-header" id="wcp-captions-back">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
              <span>Captions</span>
            </div>
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

          <button class="v10-btn" id="wcp-popout-btn" title="Open in pop-out window (survives episode changes, no fullscreen glitches)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <path d="M15 3h6v6"/><path d="M10 14L21 3"/>
            </svg>
          </button>

          <button class="v10-btn" id="wcp-fs-btn" title="Fullscreen">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
            </svg>
          </button>
        </div>
      `;

      if (isVhs) P.style.position = 'fixed';
      if (playerWrap) playerWrap.insertBefore(P, playerWrap.firstChild);
      else document.body.appendChild(P);

      // ── DOM References & Player State ─────────────────────────────────────
      const vid          = P.querySelector('#wcp-vid');
      const spinner      = P.querySelector('#wcp-spinner');
      const playSvg      = P.querySelector('#wcp-play-svg');
      const playBtn      = P.querySelector('#wcp-play-btn');
      const skipBackBtn  = P.querySelector('#wcp-skip-back-btn');
      const skipFwdBtn   = P.querySelector('#wcp-skip-fwd-btn');
      const muteBtn      = P.querySelector('#wcp-mute-btn');
      const volSlider    = P.querySelector('#wcp-vol-slider');
      const volIcon      = P.querySelector('#wcp-vol-icon');
      const progWrap     = P.querySelector('#wcp-prog-wrap');
      const progFill     = P.querySelector('#wcp-prog-fill');
      const progBuf      = P.querySelector('#wcp-prog-buf');
      const progThumb    = P.querySelector('#wcp-prog-thumb');
      const timeCurr     = P.querySelector('#wcp-time-curr');
      const timeRem      = P.querySelector('#wcp-time-rem');
      const fsBtn        = P.querySelector('#wcp-fs-btn');
      const pipBtn       = P.querySelector('#wcp-pip-btn');
      const popoutBtn    = P.querySelector('#wcp-popout-btn');
      const epPrevBtn    = P.querySelector('#wcp-ep-prev');
      const epNextBtn    = P.querySelector('#wcp-ep-next');
      epNextBtn?.addEventListener('click', e => { e.stopPropagation(); try { parent.postMessage({ type: 'WCO_GO_NEXT' }, '*'); } catch {} });
      epPrevBtn?.addEventListener('click', e => { e.stopPropagation(); try { parent.postMessage({ type: 'WCO_GO_PREV' }, '*'); } catch {} });
      syncEpArrows(); // apply whatever availability info may have already arrived
      applyTitleToDom(); // may still be blank — set for real once WCO_TITLE_INFO arrives
      const settingsBtn  = P.querySelector('#wcp-settings-btn');
      const settingsMenu = P.querySelector('#wcp-settings-menu');
      const epWrap       = P.querySelector('#wcp-ep-wrap');
      const keepBtn      = P.querySelector('#wcp-pill-keep');
      const nextBtn      = P.querySelector('#wcp-pill-next');
      const pillText     = P.querySelector('#wcp-pill-text');
      const pillTimer    = P.querySelector('#wcp-pill-timer');

      // ── First-load "choose your language" hint bubble ──────────────────
      // Shown once (ever — shared with the pop-out via wcoTrackHintSeen)
      // the first time an episode with real dub/caption tracks loads.
      // Dismissed by its ✕, by clicking the gear, or by fading out on its
      // own after ~8s; any of those marks it as seen for good.
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
        setPref('wcoTrackHintSeen', true);
      };
      const maybeShowTrackHint = () => {
        if (trackHintState !== 'idle' || !trackHint) return;
        trackHintState = 'pending';
        chrome.storage.local.get({ wcoTrackHintSeen: false }, r => {
          if (trackHintState !== 'pending') return;
          if (r.wcoTrackHintSeen) { trackHintState = 'done'; return; }
          // Handed off to a pop-out: this copy is hidden, let the pop-out show it instead.
          let linked = false; try { linked = popoutLinked; } catch {}
          if (linked) { trackHintState = 'idle'; return; }
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

      // ══════════════════════════════════════════════════════════════════
      //  SOURCE ATTACHMENT — plain src (standard embed MP4) or hls.js (VHS)
      // ══════════════════════════════════════════════════════════════════
      const HlsLib = window.Hls || null;
      let hls = null;                  // live hls.js instance for the current HLS part
      let currentSrc   = videoSrc;     // the real (non-blob) URL of whatever is attached now
      let currentIsHls = srcIsHls;
      let nativeFallback = false;

      // Remembered VHS track choices (persisted, so the next episode — and
      // the next PART of a split episode — keeps the same dub/subtitle).
      // wcoSubsPref: 'default' = leave the stream's default, null = Off.
      const trackPrefs = await new Promise(r => chrome.storage.local.get({ wcoAudioPref: null, wcoSubsPref: 'default' }, r));
      let preferredAudio = trackPrefs.wcoAudioPref;
      let preferredSubs  = trackPrefs.wcoSubsPref;
      const trackMatch = (list, pref) => {
        if (!pref || !list) return -1;
        let i = pref.name ? list.findIndex(t => t.name === pref.name) : -1;
        if (i < 0 && pref.lang) i = list.findIndex(t => t.lang === pref.lang);
        return i;
      };
      const applyPreferredTracks = () => {
        if (!hls) return;
        const ai = trackMatch(hls.audioTracks, preferredAudio);
        if (ai >= 0 && ai !== hls.audioTrack) hls.audioTrack = ai;
        if (preferredSubs === null) { if (hls.subtitleTrack !== -1) hls.subtitleTrack = -1; }
        else if (preferredSubs && preferredSubs !== 'default') {
          const si = trackMatch(hls.subtitleTracks, preferredSubs);
          if (si >= 0 && si !== hls.subtitleTrack) { hls.subtitleTrack = si; hls.subtitleDisplay = true; }
        }
      };

      // hls.js can't play this source at all (e.g. manifest blocked) —
      // give the viewer the site's own VideoJS player back rather than a
      // dead black box.
      const fallbackToNative = why => {
        if (!isVhs || nativeFallback) return;
        nativeFallback = true;
        log('VHS: hls.js failed (' + why + ') — restoring the site player');
        try { hls?.destroy(); } catch {}
        hls = null;
        try { vid.pause(); } catch {}
        P.remove();
        if (vjsContainer) vjsContainer.style.display = '';
        document.documentElement.style.overflow = '';
        document.body.style.overflow = '';
        vjsVideo?.__wcoUnsilence?.();
      };

      const attachSrc = (src, isHlsSrc) => {
        if (hls) { try { hls.destroy(); } catch {} hls = null; }
        currentSrc = src;
        currentIsHls = !!isHlsSrc;
        if (isHlsSrc && HlsLib && HlsLib.isSupported()) {
          const h = hls = new HlsLib({ enableWorker: false });
          let parsed = false;
          const refresh = () => { if (hls === h) populateHlsMenus(); };
          h.on(HlsLib.Events.MANIFEST_PARSED, () => { parsed = true; refresh(); });
          h.on(HlsLib.Events.AUDIO_TRACKS_UPDATED, () => { if (hls === h) applyPreferredTracks(); refresh(); });
          h.on(HlsLib.Events.SUBTITLE_TRACKS_UPDATED, () => { if (hls === h) applyPreferredTracks(); refresh(); });
          h.on(HlsLib.Events.AUDIO_TRACK_SWITCHED, refresh);
          h.on(HlsLib.Events.SUBTITLE_TRACK_SWITCH, refresh);
          h.on(HlsLib.Events.LEVEL_SWITCHED, refresh);
          h.on(HlsLib.Events.ERROR, (ev, data) => {
            if (!data?.fatal || hls !== h) return;
            if (!parsed) { fallbackToNative(data.details); return; }
            if (data.type === HlsLib.ErrorTypes.NETWORK_ERROR) h.startLoad();
            else if (data.type === HlsLib.ErrorTypes.MEDIA_ERROR) h.recoverMediaError();
            else fallbackToNative(data.details);
          });
          h.loadSource(src);
          h.attachMedia(vid);
        } else if (isHlsSrc && !vid.canPlayType('application/vnd.apple.mpegurl')) {
          fallbackToNative('hls.js unavailable');
        } else {
          vid.src = src; // progressive MP4 (or native HLS on Safari)
        }
      };

      // ── Audio / Captions / Quality menus straight from hls.js ─────────
      // (Same pattern as the pop-out's populateHlsMenus(); only shown for
      // HLS sources — the standard embed keeps its VJS-dropdown quality.)
      function populateHlsMenus() {
        if (!hls) return;
        // Items go into each panel's inner .wcp-subitem-list (the part that
        // scrolls for long track lists), never next to the header itself.
        const audioBtnEl = q('#wcp-btn-opt-audio', settingsMenu);
        const audioPanel = q('#wcp-panel-audio .wcp-subitem-list', settingsMenu);
        const audioLbl   = q('#wcp-lbl-audio', settingsMenu);
        const capsBtnEl  = q('#wcp-btn-opt-captions', settingsMenu);
        const capsPanel  = q('#wcp-panel-captions .wcp-subitem-list', settingsMenu);
        const capsLbl    = q('#wcp-lbl-captions', settingsMenu);
        const capStyleEntry = q('#wcp-btn-caption-style', settingsMenu);
        const qualPanel  = q('#wcp-panel-quality .wcp-subitem-list', settingsMenu);
        const qualLbl    = q('#wcp-lbl-quality', settingsMenu);
        const clearItems = panel => qa('.wcp-subitem', panel).forEach(x => x.remove());
        const addItem = (panel, text, active, onPick) => {
          const item = document.createElement('div');
          item.className = 'wcp-subitem' + (active ? ' active' : '');
          item.textContent = text;
          panel.appendChild(item);
          item.addEventListener('click', e => {
            e.stopPropagation();
            qa('.wcp-subitem', panel).forEach(x => x.classList.remove('active'));
            item.classList.add('active');
            onPick(item);
            settingsMenu.classList.remove('open');
          });
          return item;
        };
        const trackName = (t, i) => t.name || t.lang || `Track ${i + 1}`;

        // Audio dubs — only worth a menu entry if there's a real choice.
        clearItems(audioPanel);
        if (hls.audioTracks && hls.audioTracks.length > 1) {
          audioBtnEl.style.display = '';
          const cur = hls.audioTrack;
          audioLbl.textContent = trackName(hls.audioTracks[cur] || hls.audioTracks[0], Math.max(0, cur));
          hls.audioTracks.forEach((t, i) => addItem(audioPanel, trackName(t, i), i === cur, item => {
            hls.audioTrack = i;
            audioLbl.textContent = item.textContent;
            preferredAudio = { name: t.name || '', lang: t.lang || '' };
            setPref('wcoAudioPref', preferredAudio);
          }));
        } else audioBtnEl.style.display = 'none';

        // Captions / subtitles — "Off" plus every track.
        clearItems(capsPanel);
        if (hls.subtitleTracks && hls.subtitleTracks.length > 0) {
          capsBtnEl.style.display = '';
          const cur = hls.subtitleTrack;
          addItem(capsPanel, 'Off', cur < 0, () => {
            hls.subtitleTrack = -1;
            capsLbl.textContent = 'Off';
            preferredSubs = null;
            setPref('wcoSubsPref', null);
          });
          hls.subtitleTracks.forEach((t, i) => addItem(capsPanel, trackName(t, i), i === cur, item => {
            hls.subtitleTrack = i;
            hls.subtitleDisplay = true;
            capsLbl.textContent = item.textContent;
            preferredSubs = { name: t.name || '', lang: t.lang || '' };
            setPref('wcoSubsPref', preferredSubs);
          }));
          capsLbl.textContent = cur >= 0 ? trackName(hls.subtitleTracks[cur], cur) : 'Off';
          if (capStyleEntry) capStyleEntry.style.display = ''; // "Captions settings" (appearance)
        } else {
          capsBtnEl.style.display = 'none';
          if (capStyleEntry) capStyleEntry.style.display = 'none';
        }

        // Real dub/caption choice on this episode → first-load hint bubble.
        if ((hls.audioTracks && hls.audioTracks.length > 1) || (hls.subtitleTracks && hls.subtitleTracks.length > 0)) {
          maybeShowTrackHint();
        }

        // Quality — hls.js levels, switched via hls.currentLevel.
        clearItems(qualPanel);
        const lvlLabel = (l, i) => l.height ? `${l.height}p` : (l.bitrate ? `${Math.round(l.bitrate / 1000)}kbps` : `Level ${i + 1}`);
        if (hls.levels && hls.levels.length > 1) {
          const manual = hls.autoLevelEnabled ? -1 : hls.currentLevel;
          addItem(qualPanel, 'Auto', manual === -1, () => { hls.currentLevel = -1; qualLbl.textContent = 'Auto'; });
          hls.levels.forEach((l, i) => addItem(qualPanel, lvlLabel(l, i), i === manual, item => {
            hls.currentLevel = i;
            qualLbl.textContent = item.textContent;
          }));
          qualLbl.textContent = manual === -1 ? 'Auto' : lvlLabel(hls.levels[manual], manual);
        } else if (hls.levels && hls.levels.length === 1) {
          qualLbl.textContent = lvlLabel(hls.levels[0], 0);
        }
      }

      // ══════════════════════════════════════════════════════════════════
      //  MERGED MULTI-PART TIMELINE (split episodes, N ≥ 2 parts)
      //
      //  One <video>, one scrubber. `parts` stays null for normal single-
      //  video episodes, in which case every helper below degrades to the
      //  plain vid.currentTime / vid.duration behavior of v1.0.33.
      //  With parts: combinedTime = offsets[partIdx] + vid.currentTime,
      //  combinedDuration = offsets[N] (sum of every part's duration).
      // ══════════════════════════════════════════════════════════════════
      let parts = null;        // [{src, poster, isHls, duration}] — set by enterMerge()
      let offsets = [0];       // cumulative start of each part; offsets[N] = total
      let partIdx = 0;         // part currently attached to vid
      let pendingSwap = null;  // { i, local, play } while another part is loading
      let swapToken = 0;

      const totalDur = () => parts ? offsets[parts.length] : (vid.duration || 0);
      const curT = () => {
        if (!parts) return vid.currentTime || 0;
        if (pendingSwap) return offsets[pendingSwap.i] + pendingSwap.local;
        return offsets[partIdx] + (vid.currentTime || 0);
      };
      const partAt = T => { for (let i = parts.length - 1; i > 0; i--) if (T >= offsets[i]) return i; return 0; };

      const renderChapters = () => {
        const box = q('#wcp-chaps', P);
        if (!box) return;
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

      // Swap the <video> to part i, land at `local` seconds, then resume
      // (or stay paused) per `play`. The combined timeline never jumps:
      // curT() reports the target position for the whole time it loads.
      const loadPart = (i, local, play) => {
        const token = ++swapToken;
        pendingSwap = { i, local: Math.max(0, local || 0), play: !!play };
        partIdx = i;
        progWrap.classList.add('wcp-part-loading');
        spinner.classList.add('on');
        log('[split] loading part', i + 1, 'of', parts.length, '@', pendingSwap.local.toFixed(1) + 's');
        vid.addEventListener('loadedmetadata', () => {
          if (token !== swapToken || !pendingSwap) return;
          const { local: at, play: resume } = pendingSwap;
          pendingSwap = null;
          if (isFinite(vid.duration) && vid.duration > 0 && Math.abs((parts[i].duration || 0) - vid.duration) > 0.5) {
            parts[i].duration = vid.duration;   // replace an estimate with the real value
            recomputeOffsets();
          }
          try { vid.currentTime = Math.min(at, Math.max(0, (vid.duration || at + 1) - 0.5)); } catch {}
          progWrap.classList.remove('wcp-part-loading');
          if (resume && !popoutLinked) vid.play().catch(() => {}); else spinner.classList.remove('on');
          renderProgress();
          if (popoutLinked) sendSync();
        }, { once: true });
        attachSrc(parts[i].src, parts[i].isHls);
        if (parts[i].poster) vid.poster = parts[i].poster;
        renderProgress();
      };

      // THE seek entry point for every control (scrubber, ±10s, hotkeys,
      // pop-out). T is always a COMBINED time when parts are active.
      const seekCombined = T => {
        if (!parts) {
          const d = vid.duration || 0;
          vid.currentTime = Math.max(0, d ? Math.min(d, T) : T);
          return;
        }
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

      // Metadata-only probe of a part we aren't playing — used ONCE, up
      // front, to learn every part's duration before the combined
      // timeline is shown. Resolves to seconds, or null on failure/timeout.
      const probeDuration = part => new Promise(resolve => {
        const v = document.createElement('video');
        v.muted = true; v.preload = 'metadata'; v.style.display = 'none';
        let h = null, done = false;
        const finish = d => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try { h?.destroy(); } catch {}
          try { v.removeAttribute('src'); v.load(); } catch {}
          v.remove();
          resolve(isFinite(d) && d > 0 ? d : null);
        };
        const timer = setTimeout(() => finish(null), 15000);
        v.addEventListener('loadedmetadata', () => finish(v.duration));
        v.addEventListener('error', () => finish(null));
        document.body.appendChild(v);
        if (part.isHls && HlsLib && HlsLib.isSupported()) {
          h = new HlsLib({ enableWorker: false, maxBufferLength: 1, maxMaxBufferLength: 2 });
          h.on(HlsLib.Events.LEVEL_LOADED, (ev, data) => finish(data?.details?.totalduration));
          h.on(HlsLib.Events.ERROR, (ev, data) => { if (data?.fatal) finish(null); });
          h.loadSource(part.src);
          h.attachMedia(v);
        } else {
          v.src = part.src;
        }
      });
      const ownDuration = (timeoutMs) => new Promise(resolve => {
        const ok = () => isFinite(vid.duration) && vid.duration > 0;
        if (ok()) return resolve(vid.duration);
        const done = () => { if (ok()) { cleanup(); resolve(vid.duration); } };
        const cleanup = () => { vid.removeEventListener('durationchange', done); vid.removeEventListener('loadedmetadata', done); clearTimeout(t); };
        const t = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
        vid.addEventListener('durationchange', done);
        vid.addEventListener('loadedmetadata', done);
      });

      let mergeStarted = false;
      const enterMerge = async rawParts => {
        if (mergeStarted || !Array.isArray(rawParts) || rawParts.length < 2) return;
        if (!rawParts.every(p => p && typeof p.src === 'string' && /^https?:/.test(p.src))) return;
        mergeStarted = true;
        const list = rawParts.map((p, i) => ({
          src:     i === 0 ? currentSrc : p.src,           // part 0 is us — keep our live src
          poster:  i === 0 ? (poster || p.poster || '') : (p.poster || ''),
          isHls:   i === 0 ? currentIsHls : !!p.isHls,
          duration: null,
        }));
        log('[split] merge mode —', list.length, 'parts; preloading durations…');
        const [d0, ...rest] = await Promise.all([ownDuration(15000), ...list.slice(1).map(probeDuration)]);
        list[0].duration = d0;
        rest.forEach((d, k) => { list[k + 1].duration = d; });
        const known = list.map(p => p.duration).filter(Boolean);
        if (!known.length) { log('[split] no part durations resolved — staying single-part'); mergeStarted = false; return; }
        const estimate = list[0].duration || known[0];
        list.forEach((p, i) => { if (!p.duration) { p.duration = estimate; log('[split] part', i + 1, 'duration unknown — estimating', estimate); } });

        parts = list;
        partIdx = 0;
        recomputeOffsets();
        log('[split] combined timeline ready:', parts.map(p => p.duration.toFixed(1)).join(' + '), '=', totalDur().toFixed(1) + 's');
        // A standard embed's quality switch can only re-sign part 1's URL
        // (the other parts' VJS instances are gone), so hide it here.
        if (!currentIsHls) {
          const qb = q('#wcp-btn-opt-quality', settingsMenu);
          if (qb) qb.style.display = 'none';
        }
        clearCountdown();
        epWrap.classList.remove('wcp-vis');
        renderProgress();
        if (popoutLinked) sendSync();
      };

      // Keep a part's duration exact once it's actually playing.
      vid.addEventListener('durationchange', () => {
        if (!parts || pendingSwap || !isFinite(vid.duration) || vid.duration <= 0) return;
        if (Math.abs((parts[partIdx].duration || 0) - vid.duration) > 0.5) {
          parts[partIdx].duration = vid.duration;
          recomputeOffsets();
        }
      });

      attachSrc(videoSrc, srcIsHls);
      // Restore remembered volume/mute so returning viewers don't reset every episode
      const savedPrefs = await getPrefs();
      vid.volume = savedPrefs.volume;
      vid.muted  = savedPrefs.muted;

      const fmt = s => {
        s = Math.max(0, Math.floor(s || 0)); // never render negative (combined time can overshoot by a few ms)
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        return h ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
      };

      const PLAY_PATH  = 'M8 5v14l11-7z';
      const PAUSE_PATH = 'M6 19h4V5H6v14zm8-14v14h4V5h-4z';
      const updatePlayIcon = () => { playSvg.querySelector('path').setAttribute('d', vid.paused ? PLAY_PATH : PAUSE_PATH); };

      const VOL_ON  = 'M11 5L6 9H2v6h4l5 4V5z';
      const VOL_OFF = 'M11 5L6 9H2v6h4l5 4V5z M23 9l-6 6M17 9l6 6';
      const updateVolIcon = () => {
        const p = volIcon.querySelector('path');
        if (p) p.setAttribute('d', vid.muted || vid.volume === 0 ? VOL_OFF : VOL_ON);
      };
      volSlider.value = vid.muted ? 0 : vid.volume; // reflect restored state in the UI

      const togglePlay = () => { vid.paused ? vid.play() : vid.pause(); };

      // Fullscreen memory: only fires inside a real user gesture (browsers
      // reject requestFullscreen() calls made outside one). Soft-navigation
      // between episodes already keeps FS alive on its own — this only
      // matters for a fresh page load / new tab where no FS session exists.
      let fsGestureConsumed = false;
      const maybeAutoFS = async () => {
        if (fsGestureConsumed) return;
        fsGestureConsumed = true;
        const p = await getPrefs();
        if (p.autoFullscreen && p.wantsFS && !isFS()) reqFS(P);
      };

      // Control Bar Auto-Hide
      let uiTimer;
      const showUI = () => {
        P.classList.add('wcp-ui');
        clearTimeout(uiTimer);
        if (!vid.paused) uiTimer = setTimeout(() => {
          // A captions-settings dropdown is open/focused — don't yank the menu away mid-choice.
          if (settingsMenu.classList.contains('open') && settingsMenu.matches(':focus-within')) { showUI(); return; }
          P.classList.remove('wcp-ui');
          settingsMenu.classList.remove('open');
        }, 3000);
      };

      P.addEventListener('mousemove', showUI);
      P.addEventListener('touchstart', showUI, { passive: true });
      vid.addEventListener('pause', () => { P.classList.add('wcp-ui'); clearTimeout(uiTimer); updatePlayIcon(); });
      vid.addEventListener('play',  () => { showUI(); updatePlayIcon(); });

      P.addEventListener('click', e => {
        if (e.target.closest('#wcp-bar, #wcp-ep-wrap, #wcp-settings-menu, #wcp-popout-handoff')) return;
        togglePlay();
        showUI();
        maybeAutoFS();
      });

      playBtn.addEventListener('click', e => { e.stopPropagation(); togglePlay(); maybeAutoFS(); });

      // 10 Second Seek Handlers
      // (All seeks go through seekCombined(), which handles crossing into
      // another part of a split episode; for single videos it's identical
      // to setting vid.currentTime directly.)
      skipBackBtn.addEventListener('click', e => {
        e.stopPropagation();
        seekCombined(curT() - 10);
        showUI();
      });

      skipFwdBtn.addEventListener('click', e => {
        e.stopPropagation();
        seekCombined(Math.min(totalDur() || Infinity, curT() + 10));
        showUI();
      });

      // Timeline Dragging — one scrubber spanning every part.
      let dragging = false;
      const seekTo = clientX => {
        const r = progWrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
        seekCombined(pct * totalDur());
      };
      progWrap.addEventListener('mousedown', e => { dragging = true; seekTo(e.clientX); showUI(); });
      window.addEventListener('mousemove',   e => { if (dragging) seekTo(e.clientX); });
      window.addEventListener('mouseup',     () => { dragging = false; });

      // ── Scrub thumbnail preview (real captured frame, VJS v10 style) ────
      // A hidden second <video> loads the same src purely for frame capture,
      // so scrubbing the visible player never gets interrupted. We seek this
      // hidden video to the hovered timestamp, then draw its current frame
      // onto a small canvas shown above the cursor.
      const thumbVid = document.createElement('video');
      // Frame capture only works off a plain progressive src — an HLS
      // (VHS) source shows the time label only.
      if (!srcIsHls) thumbVid.src = videoSrc;
      thumbVid.muted = true;
      thumbVid.preload = 'auto';
      thumbVid.style.display = 'none';
      P.appendChild(thumbVid);
      let thumbPart = 0; // which split-episode part thumbVid currently holds

      const thumbPreview = P.querySelector('#wcp-thumb-preview');
      const thumbCanvas  = P.querySelector('#wcp-thumb-canvas');
      const thumbTimeEl  = P.querySelector('#wcp-thumb-time');
      const thumbCtx     = thumbCanvas.getContext('2d');
      if (srcIsHls) thumbPreview.classList.add('wcp-no-frame');

      let thumbSeekPending = false;
      let thumbWantedTime  = 0;

      const drawThumbFrame = () => {
        try { thumbCtx.drawImage(thumbVid, 0, 0, thumbCanvas.width, thumbCanvas.height); } catch {}
      };
      thumbVid.addEventListener('seeked', () => {
        drawThumbFrame();
        thumbSeekPending = false;
        // If a newer hover happened while we were seeking, catch up
        if (Math.abs(thumbVid.currentTime - thumbWantedTime) > 0.5) {
          thumbSeekPending = true;
          thumbVid.currentTime = thumbWantedTime;
        }
      });

      const updateThumbPreview = clientX => {
        const tot = totalDur();
        if (!tot) return;
        const r = progWrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
        const t = pct * tot;                              // combined time
        const pi = parts ? partAt(t) : 0;
        const local = parts ? t - offsets[pi] : t;        // time inside that part

        if (!srcIsHls) {
          thumbWantedTime = local;
          if (parts && pi !== thumbPart) {
            // Hovering a different part — point the frame grabber at it.
            thumbPart = pi;
            thumbSeekPending = true;
            thumbVid.addEventListener('loadedmetadata', () => {
              try { thumbVid.currentTime = thumbWantedTime; } catch {}
            }, { once: true });
            thumbVid.src = parts[pi].src;
          } else if (!thumbSeekPending) {
            thumbSeekPending = true;
            try { thumbVid.currentTime = local; } catch {}
          }
        }

        thumbTimeEl.textContent = parts ? `P${pi + 1} · ${fmt(t)}` : fmt(t);
        // Position the popup, clamped so it doesn't overflow the player edges
        const leftPx = Math.max(85, Math.min(r.width - 85, clientX - r.left));
        thumbPreview.style.left = leftPx + 'px';
        thumbPreview.classList.add('wcp-show');
      };

      const hideThumbPreview = () => thumbPreview.classList.remove('wcp-show');

      progWrap.addEventListener('mousemove', e => updateThumbPreview(e.clientX));
      progWrap.addEventListener('mouseleave', hideThumbPreview);
      progWrap.addEventListener('mouseup', hideThumbPreview);
      // Touch: show preview while dragging, hide on release
      progWrap.addEventListener('touchstart', e => updateThumbPreview(e.touches[0].clientX), { passive: true });
      progWrap.addEventListener('touchmove',  e => updateThumbPreview(e.touches[0].clientX), { passive: true });
      progWrap.addEventListener('touchend',   hideThumbPreview);

      // Scrubber + time labels. Uses COMBINED time/duration whenever a
      // split episode is merged (curT()/totalDur()), plain values otherwise.
      function renderProgress() {
        const tot = totalDur();
        if (!tot) return;
        const t = curT();
        const pct = Math.max(0, Math.min(100, (t / tot) * 100));
        progFill.style.width  = pct + '%';
        progThumb.style.left  = `calc(${pct}% - 5px)`;
        timeCurr.textContent  = fmt(t);
        timeRem.textContent   = `-${fmt(tot - t)}`;
        try {
          if (vid.buffered.length && !pendingSwap) {
            const base = parts ? offsets[partIdx] : 0;
            const buf = ((base + vid.buffered.end(vid.buffered.length - 1)) / tot) * 100;
            progBuf.style.width = Math.min(100, buf) + '%';
          }
        } catch {}
      }

      vid.addEventListener('timeupdate', async () => {
        if (!totalDur()) return;
        // Mid part-swap the <video> briefly reports the NEW part at 0s —
        // never evaluate the countdown against that transient state.
        if (pendingSwap) return;
        renderProgress();

        if (epKept) return;
        const prefs = await getPrefs();
        if (prefs.navMode === 'off') { epWrap.classList.remove('wcp-vis'); return; }

        // Sequential mode with nothing left to advance to: hide both pills
        // entirely (Keep Watching included) and don't auto-navigate either.
        if (prefs.navMode === 'next' && !nextEpisodeAvailable) {
          epWrap.classList.remove('wcp-vis');
          return;
        }

        if (pillText) pillText.textContent = prefs.navMode === 'random' ? 'Random Episode' : 'Next Episode';
        // Remaining time of the WHOLE episode (all parts) — so the pill and
        // countdown only ever appear near the end of the LAST part.
        if (pendingSwap) return; // a swap may have started during the await above
        const rem = Math.ceil(totalDur() - curT());
        const cd  = prefs.countdownDuration; // 0 (Disabled) | 5 | 10 | 15

        // "Disabled" lead mode mirrors the countdown time exactly — no extra
        // early heads-up. "Custom" (extension-only, advanced) shows the pill
        // this many seconds ahead of the real end instead.
        const lead = prefs.leadMode === 'custom'
          ? (prefs.leadTimeCustom || 60)
          : (cd || 0);

        if (rem <= lead && rem > 0) {
          epWrap.classList.add('wcp-vis');

          if (!cd) {
            // Disabled: badge shows actual seconds remaining in the video,
            // and navigation fires only once it truly ends.
            pillTimer.textContent = rem;
          } else {
            // Anchor the countdown to vid.currentTime the moment the pill
            // first appears, then derive the displayed value from actual
            // elapsed PLAYBACK time since that anchor on every tick. This:
            //   • pauses naturally — timeupdate doesn't fire while paused
            //   • re-syncs naturally on seeks — recomputed from currentTime
            //     every time, so scrubbing back a few seconds moves the
            //     displayed number back up to match, and vice versa
            //   • still fires before the video's true end when cd < lead
            //     (e.g. skip trailing credits): it's counting elapsed
            //     playback time, not remaining video runtime
            if (countdownAnchorTime === null) countdownAnchorTime = curT();
            let elapsed = curT() - countdownAnchorTime;
            if (elapsed < 0) {
              // Rewound past the original anchor point — restart the
              // countdown fresh from the full duration rather than
              // showing a number bigger than the configured setting.
              countdownAnchorTime = curT();
              elapsed = 0;
            }
            const secsLeft = Math.min(cd, Math.ceil(cd - elapsed));

            if (secsLeft <= 0) { clearCountdown(); triggerEpNext(); return; }
            pillTimer.textContent = secsLeft;
          }
        } else if (rem <= 0) {
          triggerEpNext();
        } else {
          epWrap.classList.remove('wcp-vis');
          clearCountdown(); // in case of a backward seek out of the window
        }
      });

      // Volume Controls
      muteBtn.addEventListener('click', e => {
        e.stopPropagation();
        vid.muted = !vid.muted;
        updateVolIcon();
        setPref('muted', vid.muted);
      });
      volSlider.addEventListener('input', () => {
        vid.volume = parseFloat(volSlider.value);
        vid.muted  = vid.volume === 0;
        updateVolIcon();
        setPref('volume', vid.volume);
        setPref('muted', vid.muted);
      });

      // Settings Navigation
      settingsBtn.addEventListener('click', e => {
        e.stopPropagation();
        dismissTrackHint(); // no-op unless the first-load hint is up
        settingsMenu.classList.toggle('open');
        showSubpanel('wcp-panel-main');
      });

      const showSubpanel = panelId => {
        qa('.wcp-menu-panel', settingsMenu).forEach(p => p.classList.remove('active'));
        q(`#${panelId}`, settingsMenu)?.classList.add('active');
      };

      q('#wcp-btn-opt-speed', settingsMenu).addEventListener('click', e => { e.stopPropagation(); showSubpanel('wcp-panel-speed'); });

      // Episode Advance submenu — On / Random / Disabled, same pattern as
      // Quality and Speed. The Countdown setting lives nested in this same
      // panel below a divider, since the two are closely related — scoped
      // separately via [data-navmode] vs [data-cd] so they don't collide.
      const NAVMODE_LABEL = { next: 'On', random: 'Random', off: 'Disabled' };
      const autoplayLbl = q('#wcp-lbl-autoplay');
      getPrefs().then(p => {
        if (autoplayLbl) autoplayLbl.textContent = NAVMODE_LABEL[p.navMode] || 'On';
        qa('#wcp-panel-autoplay .wcp-subitem[data-navmode]', settingsMenu).forEach(i =>
          i.classList.toggle('active', i.dataset.navmode === p.navMode)
        );
        const cd = (p.countdownDuration === 'off' || p.countdownDuration == null) ? 0 : p.countdownDuration;
        qa('#wcp-panel-autoplay .wcp-subitem[data-cd]', settingsMenu).forEach(i =>
          i.classList.toggle('active', parseInt(i.dataset.cd) === cd)
        );
      });
      q('#wcp-btn-opt-autoplay', settingsMenu).addEventListener('click', e => {
        e.stopPropagation();
        showSubpanel('wcp-panel-autoplay');
      });
      q('#wcp-autoplay-back', settingsMenu).addEventListener('click', e => {
        e.stopPropagation();
        showSubpanel('wcp-panel-main');
      });
      qa('#wcp-panel-autoplay .wcp-subitem[data-navmode]', settingsMenu).forEach(item => {
        item.addEventListener('click', e => {
          e.stopPropagation();
          qa('#wcp-panel-autoplay .wcp-subitem[data-navmode]', settingsMenu).forEach(i => i.classList.remove('active'));
          item.classList.add('active');
          const mode = item.dataset.navmode;
          setPref('navMode', mode);
          if (autoplayLbl) autoplayLbl.textContent = NAVMODE_LABEL[mode] || 'On';
          settingsMenu.classList.remove('open');
        });
      });
      // Countdown options nested in the same panel — Disabled / 5s / 10s / 15s
      qa('#wcp-panel-autoplay .wcp-subitem[data-cd]', settingsMenu).forEach(item => {
        item.addEventListener('click', e => {
          e.stopPropagation();
          qa('#wcp-panel-autoplay .wcp-subitem[data-cd]', settingsMenu).forEach(i => i.classList.remove('active'));
          item.classList.add('active');
          const secs = parseInt(item.dataset.cd); // 0 means Disabled
          setPref('countdownDuration', secs);
          settingsMenu.classList.remove('open');
        });
      });

      // Auto Fullscreen master toggle — same location/style as Autoplay.
      // Turning this off disables ALL auto-fullscreen behavior (manual FS
      // via the fullscreen button still always works either way).
      const autoFsLbl = q('#wcp-lbl-autofs');
      getPrefs().then(p => { if (autoFsLbl) autoFsLbl.textContent = p.autoFullscreen ? 'On' : 'Off'; });
      q('#wcp-btn-opt-autofs', settingsMenu).addEventListener('click', async e => {
        e.stopPropagation();
        const p = await getPrefs();
        const next = !p.autoFullscreen;
        setPref('autoFullscreen', next);
        if (!next) setPref('wantsFS', false); // clear any pending remembered state
        if (autoFsLbl) autoFsLbl.textContent = next ? 'On' : 'Off';
      });
      q('#wcp-btn-opt-quality', settingsMenu).addEventListener('click', async e => {
        e.stopPropagation();
        showSubpanel('wcp-panel-quality');
        // HLS (VHS): the panel is already filled from hls.levels by
        // populateHlsMenus() — nothing to scrape from the VJS dropdown.
        if (currentIsHls || qualitiesLoaded) return;

        // Poll up to 4s for VJS quality selector to populate the dropdown
        let quals = [];
        for (let i = 0; i < 40 && !quals.length; i++) {
          quals = readVJSQualities();
          if (!quals.length) await sleep(100);
        }
        if (!quals.length) return; // no quality selector on this episode

        qualitiesLoaded = true;
        const qualityPanel = q('#wcp-panel-quality .wcp-subitem-list', settingsMenu);

        // Set current label from VJS's active item
        const activeLi = q('.vjs-quality-dropdown li.current');
        const activeCode = activeLi?.dataset.code;
        const activeLabel = { hd1080:'FHD', hd720:'HD', hd576:'SD' }[activeCode] || 'Auto';
        q('#wcp-lbl-quality').textContent = activeLabel;

        quals.forEach(({ code, label, li }) => {
          const item = document.createElement('div');
          item.className = 'wcp-subitem' + (label === activeLabel ? ' active' : '');
          item.dataset.code = code;
          item.textContent = label;
          qualityPanel.appendChild(item);

          item.addEventListener('click', async ev => {
            ev.stopPropagation();
            const savedTime  = vid.currentTime;
            const wasPaused  = vid.paused;
            qa('#wcp-panel-quality .wcp-subitem', settingsMenu).forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            q('#wcp-lbl-quality').textContent = label;
            settingsMenu.classList.remove('open');

            // Let VJS resolve the signed URL, then copy src to our player
            spinner.classList.add('on');
            const newSrc = await resolveVJSSrc(vjsVideo, li);
            if (newSrc && newSrc !== vid.src) {
              attachSrc(newSrc, false);
              const onLoaded = () => {
                vid.removeEventListener('loadedmetadata', onLoaded);
                vid.currentTime = savedTime;
                spinner.classList.remove('on');
                if (!wasPaused) vid.play().catch(() => {});
              };
              vid.addEventListener('loadedmetadata', onLoaded);
              vid.load();
            } else {
              spinner.classList.remove('on');
            }
          });
        });
      });
      q('#wcp-speed-back', settingsMenu).addEventListener('click', e => { e.stopPropagation(); showSubpanel('wcp-panel-main'); });
      q('#wcp-quality-back', settingsMenu).addEventListener('click', e => { e.stopPropagation(); showSubpanel('wcp-panel-main'); });
      // Audio / Captions (HLS only — entries stay hidden unless populateHlsMenus() finds tracks)
      q('#wcp-btn-opt-audio', settingsMenu).addEventListener('click', e => { e.stopPropagation(); showSubpanel('wcp-panel-audio'); });
      q('#wcp-audio-back', settingsMenu).addEventListener('click', e => { e.stopPropagation(); showSubpanel('wcp-panel-main'); });
      q('#wcp-btn-opt-captions', settingsMenu).addEventListener('click', e => { e.stopPropagation(); showSubpanel('wcp-panel-captions'); });
      q('#wcp-captions-back', settingsMenu).addEventListener('click', e => { e.stopPropagation(); showSubpanel('wcp-panel-main'); });

      // ── Captions settings (appearance) — our own version of VideoJS's
      // "captions settings" dialog, as a regular submenu panel.
      //
      // How it renders: hls.js hands subtitles to the browser as native
      // <track> text tracks, drawn by Chrome's built-in cue renderer, so
      // styling goes through the ::cue pseudo-element scoped to our
      // <video> via a dedicated <style id="wcp-caption-style"> that is
      // rewritten on every change.
      //
      // Known limitations (::cue only accepts a subset of CSS):
      //  • "Caption Area Background" (the VJS "window") has no ::cue
      //    equivalent. Approximated with Chrome's internal
      //    ::-webkit-media-text-track-display box (in its own rule, so if
      //    a browser rejects that selector nothing else breaks) and, when
      //    the text background is Transparent, by painting the cue
      //    background with the window color instead.
      //  • Edge styles are text-shadow approximations of VJS's own.
      //  • All-default settings emit NO rules at all, so anyone who never
      //    opens this keeps the browser's native caption look untouched.
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
        if (Object.keys(CAP_DEFAULTS).every(k => String(s[k]) === CAP_DEFAULTS[k])) return '';
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
      const capPanel = q('#wcp-panel-caption-style', settingsMenu);
      let capSettings = { ...CAP_DEFAULTS };
      const applyCaptionAppearance = saved => {
        capSettings = { ...CAP_DEFAULTS };
        if (saved && typeof saved === 'object') Object.keys(CAP_DEFAULTS).forEach(k => { if (saved[k] != null) capSettings[k] = String(saved[k]); });
        capStyleEl.textContent = buildCaptionCss(capSettings);
        qa('select[data-cs]', capPanel).forEach(sel => { sel.value = capSettings[sel.dataset.cs]; });
      };
      // Load on init + follow changes made anywhere else (the pop-out, another tab).
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
      // Instant-apply + save on every change, like every other setting here.
      qa('select[data-cs]', capPanel).forEach(sel => sel.addEventListener('change', () => {
        const next = { ...capSettings, [sel.dataset.cs]: sel.value };
        applyCaptionAppearance(next);
        saveCaptionAppearance(next);
        sel.blur(); // let the menu auto-hide normally again
      }));
      capPanel.addEventListener('click', e => e.stopPropagation());
      q('#wcp-btn-caption-style', settingsMenu).addEventListener('click', e => { e.stopPropagation(); showSubpanel('wcp-panel-caption-style'); });
      q('#wcp-caption-style-back', settingsMenu).addEventListener('click', e => { e.stopPropagation(); showSubpanel('wcp-panel-captions'); });
      q('#wcp-cs-reset', settingsMenu).addEventListener('click', e => {
        e.stopPropagation();
        applyCaptionAppearance(null);
        saveCaptionAppearance(null); // Reset = back to defaults (stored key removed)
      });
      q('#wcp-cs-done', settingsMenu).addEventListener('click', e => { e.stopPropagation(); settingsMenu.classList.remove('open'); });

      populateHlsMenus(); // in case the manifest was parsed before the menu wiring ran

      // Speed Options
      qa('#wcp-panel-speed .wcp-subitem', settingsMenu).forEach(item => {
        item.addEventListener('click', e => {
          e.stopPropagation();
          qa('#wcp-panel-speed .wcp-subitem', settingsMenu).forEach(i => i.classList.remove('active'));
          item.classList.add('active');
          const spd = parseFloat(item.dataset.speed);
          vid.playbackRate = spd;
          q('#wcp-lbl-speed').textContent = spd === 1 ? '1×' : `${spd}×`;
          settingsMenu.classList.remove('open');
        });
      });

      // Quality items injected lazily on first panel open (see #wcp-btn-opt-quality handler above)

      // PiP
      pipBtn.addEventListener('click', async e => {
        e.stopPropagation();
        try {
          if (document.pictureInPictureElement) await document.exitPictureInPicture();
          else if (document.pictureInPictureEnabled && vid) await vid.requestPictureInPicture();
        } catch (err) { log('PiP error:', err); }
      });

      // Cast — uses the standard Remote Playback API (video.remote), the
      // same mechanism behind the browser's built-in right-click "Cast..."
      // option. This works on any plain <video> element with no external
      // SDK; it opens the native device picker (Chromecast, etc.) directly.
      // Only shown when the API + at least one candidate device exists.
      const castBtn = P.querySelector('#wcp-cast-btn');
      if (castBtn && 'remote' in vid) {
        vid.remote.watchAvailability(available => {
          castBtn.style.display = available ? '' : 'none';
        }).catch(() => {
          // Some browsers throw if availability monitoring isn't supported
          // even though .remote exists — show the button anyway and let
          // the prompt() call itself fail gracefully if there's no device.
          castBtn.style.display = '';
        });

        castBtn.addEventListener('click', async e => {
          e.stopPropagation();
          try { await vid.remote.prompt(); }
          catch (err) { log('Cast prompt error/cancelled:', err.message); }
        });
      }

      // Pop-out window — a borderless, maximized popup window running the
      // same page. Unlike the Fullscreen API, this has no "exit on
      // navigation" restriction at all (that rule only applies to the
      // Fullscreen API specifically), so it survives moving between
      // episodes without ever dropping out, and needs no gesture-timing
      // workarounds. We're cross-origin inside the embed iframe here, so
      // we can't read the parent page's real URL directly — ask it instead.
      popoutBtn?.addEventListener('click', e => {
        e.stopPropagation();
        try { chrome.runtime.sendMessage({ action: 'OPEN_POPOUT' }); } catch {}
      });

      // Buffering Spinners
      vid.addEventListener('waiting', () => spinner.classList.add('on'));
      vid.addEventListener('canplay', () => spinner.classList.remove('on'));
      vid.addEventListener('playing', () => spinner.classList.remove('on'));

      // Fullscreen
      fsBtn.addEventListener('click', async e => {
        e.stopPropagation();
        const p = await getPrefs();
        if (isFS()) { exitFS(); if (p.autoFullscreen) setPref('wantsFS', false); }
        else { reqFS(P); if (p.autoFullscreen) setPref('wantsFS', true); }
      });
      // Also clear the preference if the user exits via Esc / swipe-down
      ['fullscreenchange','webkitfullscreenchange','mozfullscreenchange'].forEach(ev =>
        document.addEventListener(ev, async () => {
          P.classList.toggle('wcp-is-fullscreen', isFS());
          if (!isFS()) { const p = await getPrefs(); if (p.autoFullscreen) setPref('wantsFS', false); }
        })
      );
      if (sessionStorage.getItem(FS_KEY) === '1') {
        sessionStorage.removeItem(FS_KEY);
        setTimeout(() => reqFS(P), 600);
      }

      // Hotkeys
      document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
        if (e.code === 'Space')      { e.preventDefault(); togglePlay(); }
        if (e.code === 'ArrowLeft')  { seekCombined(curT() - 10); }
        if (e.code === 'ArrowRight') { seekCombined(Math.min(totalDur() || 0, curT() + 10)); }
        if (e.code === 'KeyF')       { isFS() ? exitFS() : reqFS(P); }
        if (e.code === 'KeyM')       { vid.muted = !vid.muted; updateVolIcon(); }
        if (e.code === 'KeyP')       { pipBtn.click(); }
      });

      // Navigation Handlers
      let epTriggered = false, epKept = false;
      // Countdown is anchored to vid.currentTime rather than a blind
      // setInterval — this makes it automatically:
      //   • pause when the video pauses (timeupdate simply stops firing)
      //   • re-sync correctly if the user seeks backward/forward while the
      //     pill is showing (recomputed straight from currentTime each tick)
      // while STILL allowing it to fire before the video's true end when
      // countdownDuration is smaller than the lead-in window (e.g. skip
      // trailing credits): it counts down actual elapsed PLAYBACK time
      // since the pill first appeared, not the video's remaining runtime.
      let countdownAnchorTime = null; // vid.currentTime when the pill first appeared
      const clearCountdown = () => { countdownAnchorTime = null; };
      const triggerEpNext = async () => {
        if (epTriggered || epKept) return;
        epTriggered = true;
        clearCountdown();
        epWrap.classList.remove('wcp-vis');
        const p = await getPrefs();
        if (p.autoFullscreen && isFS()) {
          sessionStorage.setItem(FS_KEY, '1');
          try { parent.postMessage({ type: 'WCO_ENTER_FS' }, '*'); } catch {}
        }
        try { parent.postMessage({ type: 'WCO_VIDEO_ENDED' }, '*'); } catch {}
      };
      keepBtn.addEventListener('click', e => { e.stopPropagation(); epKept = true; clearCountdown(); epWrap.classList.remove('wcp-vis'); });
      nextBtn.addEventListener('click', e => { e.stopPropagation(); epKept = false; triggerEpNext(); });
      // A part of a split episode ending is NOT the episode ending: roll
      // straight into the next part (duration already known, so the
      // combined timeline doesn't jump) with no pill/countdown. Only the
      // LAST part's end runs the normal next-episode logic.
      vid.addEventListener('ended', () => {
        if (parts && !pendingSwap && partIdx < parts.length - 1) {
          log('[split] part', partIdx + 1, 'ended — continuing with part', partIdx + 2);
          loadPart(partIdx + 1, 0, true);
          return;
        }
        triggerEpNext();
      });

      // Autoplay: fires IMMEDIATELY once the player is built — never waits
      // on the ad-close flow. watchClose() runs independently (see boot())
      // and just auto-clicks the close button whenever it appears; it has
      // no bearing on whether or when our own video starts playing.
      //   1. Try unmuted play (works on desktop / primed sessions)
      //   2. If blocked: start muted (always allowed) → unmute immediately
      //      Muted play activates the audio context so unmuting works right away.
      const triggerAutoplay = async () => {
        updatePlayIcon();
        showUI();

        try {
          await vid.play();
          updatePlayIcon();
          log('Autoplay: unmuted ✓');
        } catch {
          // Browser blocked unmuted — try muted then unmute
          vid.muted = true;
          try {
            await vid.play();
            vid.muted  = false;
            vid.volume = 1;
            updatePlayIcon();
            updateVolIcon();
            log('Autoplay: muted→unmuted ✓');
          } catch (err) {
            log('Autoplay blocked — tap play:', err.message);
            showUI();
          }
        }
      };

      // ── Pop-out mirror sync ─────────────────────────────────────────────
      // IMPORTANT: the request/response handlers below (INIT_REQUEST,
      // COMMAND, RESOLVE_QUALITY) are registered UNCONDITIONALLY, not
      // gated behind a one-time "is a pop-out linked?" check performed at
      // page-load time. That one-time check runs before the user has even
      // clicked "open pop-out," so it always said "no" and the listeners
      // never got registered — the exact bug that left the pop-out stuck
      // on "Connecting…" the first time, only working after a reload (by
      // which point the check correctly saw the already-open pop-out).
      let syncInterval = null;
      let popoutLinked = false;

      const currentQualityLabel = () => {
        const li = q('.vjs-quality-dropdown li.current');
        return li ? ({ hd1080:'FHD', hd720:'HD', hd576:'SD' }[li.dataset.code] || 'Auto') : 'Auto';
      };

      // "paused" is deliberately NOT sent here. Once handed off, this
      // tab's own video is ALWAYS paused (that's the point — only one
      // copy should be actively downloading). Sending that as if it were
      // meaningful playback info previously made the pop-out immediately
      // pause itself on every new episode (which starts paused-for-
      // handoff) even though the pop-out was the one meant to be playing.
      //
      // Also persisted to chrome.storage — not just broadcast live. This
      // is what lets a fresh page load (which may be a good while after
      // the pop-out last heard anything, if this tab was throttled in the
      // background) know what the pop-out was ACTUALLY last showing, so
      // it can detect + correct a mismatch rather than assuming its own
      // freshly-loaded state is automatically what the pop-out has.
      // Media fields shared by every sync + the init handshake.
      //  • videoSrc is the REAL URL (the saturn .m3u8 on VHS — never the
      //    unusable blob: URL) with isHls telling the pop-out to use hls.js.
      //  • episodeKey is stable for this whole page load (the first part's
      //    original src), so part swaps / quality changes inside ONE
      //    episode are never mistaken by the pop-out for a new episode.
      //  • parts (null for single videos) carries the ordered part list
      //    WITH durations, so the pop-out renders the identical combined
      //    timeline; partIndex + currentTime (local to that part) seed it.
      const mediaState = () => ({
        videoSrc: currentSrc,
        isHls: currentIsHls,
        episodeKey: videoSrc,
        parts: parts ? parts.map(({ src, poster: pp, isHls: ih, duration }) => ({ src, poster: pp, isHls: ih, duration })) : null,
        partIndex: pendingSwap ? pendingSwap.i : partIdx,
        currentTime: pendingSwap ? pendingSwap.local : vid.currentTime,
        duration: vid.duration,
      });

      const sendSync = () => {
        const payload = {
          ...mediaState(),
          volume: vid.volume,
          muted: vid.muted,
          titleShow: episodeShow,
          titleMeta: episodeMeta,
          nextEpisodeUrl: cachedNextEpisodeUrl,
          prevEpisodeUrl: cachedPrevEpisodeUrl,
          updatedAt: Date.now(),
        };
        try { chrome.runtime.sendMessage({ type: 'WCO_POPOUT_SYNC', ...payload }); } catch {}
        try { chrome.storage.local.set({ wcoLastSync: payload }); } catch {}
      };

      // ── Pause locally + fully hide behind a placeholder once a pop-out
      // takes over. Stops the local copy from continuing to download, and
      // eliminates any chance of double audio. ──────────────────────────
      let handoffOverlay = null;
      let desiredStateOnReturn = { paused: false };

      const showHandoffOverlay = () => {
        if (handoffOverlay) return;
        vid.pause();
        handoffOverlay = document.createElement('div');
        handoffOverlay.id = 'wcp-popout-handoff';
        handoffOverlay.style.cssText = `
          position:absolute; inset:0; z-index:45; background:#000;
          display:flex; align-items:center; justify-content:center; flex-direction:column; gap:10px;
          color:#fff; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif; text-align:center;
        `;
        handoffOverlay.innerHTML = `
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#7b8cde" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 20V10a2 2 0 0 1 2-2h6"/><path d="M9 3h6v6"/><path d="M4 14L15 3"/>
          </svg>
          <div style="font-size:14px;font-weight:600;">Playing in pop-out window</div>
          <div style="font-size:11px;color:#888;max-width:260px;">Playback paused here to avoid downloading the video twice.</div>
          <button id="wcp-force-resync" style="margin-top:6px;padding:7px 16px;border-radius:7px;
            border:1px solid #333;background:#151515;color:#ccc;font-size:12px;cursor:pointer;">
            ↻ Resync pop-out
          </button>
        `;
        P.appendChild(handoffOverlay);
        handoffOverlay.querySelector('#wcp-force-resync').addEventListener('click', e => {
          e.stopPropagation();
          const btn = e.target;
          btn.textContent = 'Checking…';
          // Re-verify a pop-out is genuinely still linked before assuming
          // it is — background.js's check confirms the window actually
          // still exists, not just a stored reference, so this is what
          // lets an overlay stuck showing because of a stale link
          // correct itself immediately, without needing a page refresh.
          chrome.runtime.sendMessage({ type: 'WCO_POPOUT_STATUS_QUERY' }, (res) => {
            if (!res?.active) {
              popoutLinked = false;
              if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
              hideHandoffOverlay();
              return;
            }
            // Genuinely still linked — the pop-out's own sync handler
            // already detects a changed videoSrc and reconciles to it,
            // so this alone covers a "wrong show" mismatch too, not
            // just a stale-but-correct one.
            sendSync();
            btn.textContent = '✓ Sent';
            setTimeout(() => { btn.textContent = '↻ Resync pop-out'; }, 1500);
          });
        });
      };
      const hideHandoffOverlay = () => {
        if (!handoffOverlay) return;
        handoffOverlay.remove();
        handoffOverlay = null;
        if (!desiredStateOnReturn.paused) vid.play().catch(() => {});
      };

      const startPopoutSync = () => {
        if (popoutLinked) return;
        popoutLinked = true;
        log('Pop-out linked — starting sync');
        showHandoffOverlay();
        syncInterval = setInterval(sendSync, 1000);
        ['play', 'pause', 'volumechange', 'seeked'].forEach(ev => vid.addEventListener(ev, sendSync));
        sendSync();

        // Deliberately NOT running an automatic periodic "is it still
        // there?" check here. An earlier version did (every 20s), and it
        // caused a worse bug than the one it was meant to prevent: it
        // could decide the pop-out was gone and resume playback here
        // while the pop-out was still genuinely active, producing
        // exactly the "playing in both places at once" problem. The
        // pop-out is meant to run fully independently during normal
        // playback — this tab doesn't need to keep double-checking that
        // in the background. Recovery instead happens at meaningful,
        // event-driven moments only: an explicit WCO_POPOUT_DISCONNECTED
        // message, the pop-out's own "pop back in" button, the user
        // switching back to this tab (below), or clicking Resync.
      };

      // The moment this tab becomes visible again — whether that's the
      // user switching back to it, or just bringing the browser window
      // forward — is exactly when "continue where they left off
      // watching here" should kick in, and a natural, meaningful point
      // to check in (unlike an arbitrary timer that fires regardless of
      // any real user action). If the pop-out is still genuinely open,
      // this just pushes it a fresh sync so it's caught up on anything
      // that happened while this tab was quiet; if it's actually gone,
      // this is what resumes playback here.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        chrome.runtime.sendMessage({ type: 'WCO_POPOUT_STATUS_QUERY' }, (res) => {
          if (res?.active) {
            if (!popoutLinked) { startPopoutSync(); } else { sendSync(); }
          } else if (popoutLinked) {
            popoutLinked = false;
            if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
            hideHandoffOverlay();
          }
        });
      });

      // Checked BEFORE ever calling triggerAutoplay() — this ordering is
      // what actually matters. Autoplay unmutes and plays audibly by
      // design; if we called it first and only paused-for-handoff
      // afterward, there was an audible blip of sound on every episode
      // transition while a pop-out was open, before the pause caught up.
      // Checking first means: if a pop-out already exists, we go straight
      // to muted/paused handoff mode and never make a sound here at all.
      chrome.runtime.sendMessage({ type: 'WCO_POPOUT_STATUS_QUERY' }, (res) => {
        if (res?.active) {
          try { vid.muted = true; } catch {}
          startPopoutSync();
        } else {
          triggerAutoplay();
        }
      });

      // The pop-out closed (any way — its own "pop back in" button, the
      // window's X button, etc.) — resume normal local playback here.
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type === 'WCO_POPOUT_DISCONNECTED') {
          popoutLinked = false;
          if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
          hideHandoffOverlay();
        }
      });

      // ── Remote control + setup requests from the pop-out's own UI ──────
      // Registered unconditionally (see note above) — this is what fixes
      // the "stuck on Connecting" bug, since it answers the very first
      // WCO_POPOUT_INIT_REQUEST regardless of prior linkage state.
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg?.type === 'WCO_POPOUT_COMMAND') {
          if (popoutLinked) {
            // Handed off — don't actually (re)start real playback on this
            // dormant copy; just remember what to restore once it's back.
            if (msg.command === 'play')  desiredStateOnReturn.paused = false;
            if (msg.command === 'pause') desiredStateOnReturn.paused = true;
            if (msg.command === 'seek')      seekCombined(msg.value); // combined time when merged
            if (msg.command === 'setVolume') { vid.volume = msg.value; vid.muted = msg.value === 0; }
            if (msg.command === 'toggleMute') vid.muted = !vid.muted;
            if (msg.command === 'setSpeed')  vid.playbackRate = msg.value;
          } else {
            if (msg.command === 'play')        vid.play().catch(() => {});
            if (msg.command === 'pause')       vid.pause();
            if (msg.command === 'toggleMute')  vid.muted = !vid.muted;
            if (msg.command === 'setVolume')   { vid.volume = msg.value; vid.muted = msg.value === 0; }
            if (msg.command === 'seek')        seekCombined(msg.value);
            if (msg.command === 'setSpeed')    vid.playbackRate = msg.value;
          }
          return;
        }

        // Pop-out just opened and needs the current video + quality list
        // to build its own copy of the real player. Receiving this at all
        // is definitive proof a pop-out now exists — start syncing.
        if (msg?.type === 'WCO_POPOUT_INIT_REQUEST') {
          // Read the play state BEFORE the hand-off pauses this copy, so the
          // pop-out continues playing if the tab was playing.
          const wasPausedBeforeHandoff = popoutLinked ? true : vid.paused;
          startPopoutSync();
          (async () => {
            // [{code, label, li}] — li isn't cloneable, strip it. None for
            // HLS (the pop-out reads hls.levels itself) or a merged
            // standard episode (only part 1's URL could be re-signed).
            const quals = (currentIsHls || parts) ? [] : readVJSQualities();
            sendResponse({
              ...mediaState(),
              poster: vid.poster || poster || '',
              paused: wasPausedBeforeHandoff,
              volume: vid.volume,
              muted: vid.muted,
              qualities: quals.map(({ code, label }) => ({ code, label })),
              currentQuality: currentQualityLabel(),
              titleShow: episodeShow,
              titleMeta: episodeMeta,
              nextEpisodeUrl: cachedNextEpisodeUrl,
              prevEpisodeUrl: cachedPrevEpisodeUrl,
            });
          })();
          return true; // keep the message channel open for the async response
        }

        // Pop-out picked a quality — only the embed's real VJS instance
        // can resolve the actual signed URL for it.
        if (msg?.type === 'WCO_POPOUT_RESOLVE_QUALITY') {
          (async () => {
            const quals = readVJSQualities();
            const target = quals.find(q2 => q2.code === msg.code);
            if (!target) { sendResponse({ url: null }); return; }
            const newSrc = await resolveVJSSrc(vjsVideo, target.li);
            if (newSrc && newSrc !== vid.src) {
              const savedTime = vid.currentTime;
              attachSrc(newSrc, false);
              vid.addEventListener('loadedmetadata', () => { vid.currentTime = savedTime; }, { once: true });
              vid.load();
            }
            sendResponse({ url: newSrc || null });
          })();
          return true;
        }

        // Pop-out is popping back in — the button in ITS bar was clicked.
        // Just resume here; the pop-out closes itself and background.js
        // will also send WCO_POPOUT_DISCONNECTED as a backup path.
        if (msg?.type === 'WCO_POPOUT_POP_BACK_IN') {
          popoutLinked = false;
          if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
          hideHandoffOverlay();
          return;
        }
      });

      // Stop trying once this document goes away (real navigation to the
      // next episode) — the fresh page load re-queries and re-links itself.
      window.addEventListener('pagehide', () => {
        if (syncInterval) clearInterval(syncInterval);
      });

      // ── Split-episode hand-off ──────────────────────────────────────
      // Everything is wired — tell the parent our own source (it needs it
      // as part 1 of a split episode; harmless on normal pages), then
      // accept the ordered part list whenever the parent sends it.
      onMergeParts = list => { enterMerge(list); };
      if (queuedMergeParts) enterMerge(queuedMergeParts);
      reportPartSrc({ src: videoSrc, poster, isHls: srcIsHls });
    };

    const boot = () => {
      // Secondary part of a split episode: report source, never play.
      if (isSecondaryPart()) { runHarvest(); return; }
      if (isVhs && !isVhsPlayerPage) {
        // VHS announcement stage — just auto-dismiss it; the page then
        // navigates itself to /video-js/, where this script runs again
        // and builds the player.
        watchClose();
        // Safety net: if this page ever renders the VJS player itself
        // (no announcement stage), build on it here instead.
        (async () => {
          for (let i = 0; i < 80; i++) {
            if (q('#hls') || q('video.vjs-tech')) { buildPlayer(); return; }
            await sleep(250);
          }
        })();
        return;
      }
      if (isEmbed) watchClose();
      buildPlayer();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PARENT PAGE (wco.tv / wcostream.tv)
  // ══════════════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════════════
  //  PLAYER-IFRAME ORCHESTRATION — runs from document_start, driven by a
  //  MutationObserver so it acts the instant each player iframe is inserted
  //  (usually before that iframe has even started loading).
  //
  //  Pattern A (VHS + redundant standard fallback, e.g. "7 Seeds"):
  //    If ANY vhs.wcostream.com iframe exists, every standard player iframe
  //    (embed.wcostream.com / cizgi-js-N) is REMOVED from the DOM together
  //    with its wrapper + trailing <br>/"Report" row. A removed iframe has
  //    no browsing context, so it can never play audio — no gating needed.
  //
  //  Pattern B (split multi-part episode, e.g. SpongeBob — N ≥ 2 parts):
  //    Among the surviving iframes of ONE type (VHS-vs-VHS or std-vs-std),
  //    the first in DOM order is the primary. Every 2nd+ iframe is named
  //    "wco-part-N" immediately, which puts its content script in harvest
  //    mode (reports its source, never builds a player, never plays) and is
  //    visually collapsed. Once every part has reported, the ordered list
  //    is sent to the primary (WCO_MERGE_PARTS), which builds ONE combined
  //    timeline, and the secondary iframes are removed from the DOM.
  // ══════════════════════════════════════════════════════════════════════════
  const classifyPlayerIfr = ifr => {
    const src = ifr.getAttribute('src') || '';
    if (/^(https?:)?\/\/vhs\.wcostream\.com\//i.test(src)) return 'vhs';
    if (/^(https?:)?\/\/embed\.wcostream\.com\//i.test(src)) return 'std';
    if (/^cizgi-js-\d+$/i.test(ifr.id)) return 'std';
    return null;
  };
  const docOrder = (a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;

  // The iframe's own wrapper: climb while the parent holds no other iframe
  // and is small (a player box, not a page section). Capped at 3 levels so
  // this can never swallow real page content.
  const playerWrapperOf = ifr => {
    let el = ifr;
    for (let d = 0; d < 3; d++) {
      const p = el.parentElement;
      if (!p || p === document.body || p === document.documentElement) break;
      if (p.querySelectorAll('iframe').length !== 1) break;
      if ((p.textContent || '').trim().length > 200) break;
      el = p;
    }
    return el;
  };

  // Trailing per-player clutter (<br>, the "Report" link row, its inline
  // script) after a removed wrapper. The parser may not have produced
  // these yet when the removal happens mid-parse, so a hidden marker is
  // left in the wrapper's place and swept again on later passes.
  const sweepAfterMarker = marker => {
    for (let i = 0; i < 4; i++) {
      const n = marker.nextElementSibling;
      if (!n) {
        if (document.readyState === 'loading') return false; // not parsed yet — try again later
        break;                                               // genuinely last in its container
      }
      const isReportRow = n.classList?.contains('anti-ad') && /^report$/i.test((n.textContent || '').trim());
      if (n.tagName === 'BR' || n.tagName === 'SCRIPT' || isReportRow) { n.remove(); continue; }
      break;
    }
    marker.remove();
    return true;
  };
  const pendingMarkers = new Set();

  const removedIfrs = new WeakSet();
  const removePlayerIframe = (ifr, why) => {
    if (!ifr || removedIfrs.has(ifr)) return;
    removedIfrs.add(ifr);
    const wrap = playerWrapperOf(ifr);
    log('Removing player iframe (' + why + '):', ifr.id || ifr.getAttribute('src'));
    const marker = document.createElement('span');
    marker.hidden = true;
    marker.setAttribute('data-wco-removed', '');
    if (wrap.parentNode) wrap.replaceWith(marker); else ifr.remove();
    if (ifr.isConnected) ifr.remove();
    if (marker.isConnected) pendingMarkers.add(marker);
  };

  // Secondary parts are hidden (not removed) only while they harvest.
  const collapsedWraps = new Map();
  const collapseWrap = ifr => {
    const w = playerWrapperOf(ifr);
    if (collapsedWraps.has(ifr)) return;
    collapsedWraps.set(ifr, { w, css: w.style.cssText });
    w.style.cssText += ';height:0 !important;min-height:0 !important;overflow:hidden !important;margin:0 !important;padding:0 !important;border:0 !important;';
  };
  const uncollapseWrap = ifr => {
    const c = collapsedWraps.get(ifr);
    if (!c) return;
    c.w.style.cssText = c.css;
    collapsedWraps.delete(ifr);
  };

  const partReports = new Map();   // iframe element -> { src, poster, isHls }
  let mergeDone = false;
  let mergeDeadline = null;        // armed at DOMContentLoaded
  let currentGroup = [];

  const livePlayerIfrs = () => qa('iframe')
    .filter(f => !removedIfrs.has(f))
    .map(f => ({ f, kind: classifyPlayerIfr(f) }))
    .filter(x => x.kind);

  const finishMerge = (group, reports) => {
    mergeDone = true;
    const primary = group[0];
    const parts = reports.map(r => ({ src: r.src, poster: r.poster || '', isHls: !!r.isHls }));
    log('[split] merging', parts.length, 'parts into the primary player');
    try { primary.contentWindow.postMessage({ type: 'WCO_MERGE_PARTS', parts }, '*'); } catch {}
    group.slice(1, parts.length).forEach(f => removePlayerIframe(f, 'split part ' + (group.indexOf(f) + 1) + ' merged'));
    // Parts that never reported (only possible after the deadline) stay
    // on the page as the site's own player — never silently dropped.
    group.slice(parts.length).forEach(uncollapseWrap);
  };

  const maybeMerge = (force = false) => {
    if (mergeDone) return;
    const group = currentGroup;
    if (group.length < 2 || document.readyState === 'loading') return;
    const reports = group.map(f => partReports.get(f));
    if (reports.every(Boolean)) { finishMerge(group, reports); return; }
    if (!force) return;
    // Deadline hit: merge the leading run of parts that DID report (a gap
    // would play parts out of order), leave the rest visible as-is.
    const prefix = [];
    for (const r of reports) { if (!r) break; prefix.push(r); }
    if (prefix.length >= 2) finishMerge(group, prefix);
    else { mergeDone = true; group.slice(1).forEach(uncollapseWrap); log('[split] parts never reported — leaving site players as-is'); }
  };

  const scanPlayers = () => {
    const live = livePlayerIfrs();
    const vhs = live.filter(x => x.kind === 'vhs').map(x => x.f).sort(docOrder);
    const std = live.filter(x => x.kind === 'std').map(x => x.f).sort(docOrder);

    // Pattern A — VHS present: the standard player(s) are redundant.
    if (vhs.length) {
      std.forEach(f => removePlayerIframe(f, 'VHS player present'));
      std.length = 0;
      // The site's "×" on the VHS box exists to reveal the standard
      // fallback, which is gone now — closing VHS would leave nothing.
      qa('a[onclick*="myFunction(\'anime-video"]').forEach(a => {
        const box = a.parentElement && a.parentElement.children.length === 1 ? a.parentElement : a;
        box.style.setProperty('display', 'none', 'important');
      });
    }

    // Two standard iframes carrying the SAME file are mirrors, not parts
    // of a split episode — the later one is redundant, same as Pattern A.
    const seenFiles = new Set();
    for (let i = 0; i < std.length; i++) {
      let file = null;
      try { file = new URL(std[i].getAttribute('src') || '', location.href).searchParams.get('file'); } catch {}
      if (file && seenFiles.has(file)) { removePlayerIframe(std[i], 'duplicate mirror of the same file'); std.splice(i--, 1); continue; }
      if (file) seenFiles.add(file);
    }

    // Pattern B — split parts among the surviving same-type players.
    const group = vhs.length ? vhs : std;
    currentGroup = group;
    if (!mergeDone && group.length >= 2) {
      group.forEach((f, i) => {
        if (i === 0) return;
        const nm = 'wco-part-' + i;
        if (f.name !== nm) f.name = nm;   // → harvest mode inside that frame
        collapseWrap(f);
      });
    }
    pendingMarkers.forEach(m => { if (!m.isConnected || sweepAfterMarker(m)) pendingMarkers.delete(m); });
    maybeMerge();
  };

  window.addEventListener('message', e => {
    if (e?.data?.type !== 'WCO_PART_SRC' || typeof e.data.src !== 'string') return;
    const f = currentGroup.find(x => { try { return x.contentWindow === e.source; } catch { return false; } });
    if (!f || partReports.has(f)) return;
    partReports.set(f, { src: e.data.src, poster: e.data.poster || '', isHls: !!e.data.isHls });
    log('[split] part', currentGroup.indexOf(f) + 1, 'reported its source');
    maybeMerge();
  });

  new MutationObserver(scanPlayers).observe(document, { childList: true, subtree: true });
  scanPlayers();
  const onPlayersDomReady = () => {
    scanPlayers();
    // VHS parts need up to ~12s for their announcement countdown before
    // their source is known; give every part generous time to report.
    if (!mergeDeadline) mergeDeadline = setTimeout(() => { scanPlayers(); maybeMerge(true); }, 40000);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onPlayersDomReady, { once: true });
  else onPlayersDomReady();
  const episodes = [];
  let epPromise  = null;

  const scrapeEps = () => {
    qa('#sidebar .menu .menustyle ul li a[href], a[rel="bookmark"][href], #sidebar_right3 .cat-eps a[href]').forEach(a => {
      if (a.href && !episodes.some(e => sameURL(e.url, a.href)))
        episodes.push({ url: a.href, title: (a.textContent || '').trim() });
    });
  };

  const fetchSeriesEps = () => {
    if (epPromise) return epPromise;
    const cat = q('a[rel="category tag"][href*="/anime/"]');
    if (!cat) return Promise.resolve();
    epPromise = fetch(cat.href).then(r => r.text()).then(html => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('#sidebar .menu .menustyle ul li a[href], #sidebar_right3 .cat-eps a[href]').forEach(a => {
        if (a.href && !episodes.some(e => sameURL(e.url, a.href)))
          episodes.push({ url: a.href, title: (a.textContent || '').trim() });
      });
    }).catch(() => {});
    return epPromise;
  };

  const ensureEps = async (timeout = 4000) => {
    scrapeEps();
    if (episodes.length < 2) {
      // Actually wait for the full series list to load, bounded by timeout —
      // previously this only awaited when the sidebar had ZERO entries,
      // so a partially-visible sidebar (very common) meant the "is this
      // the last episode" check ran against an incomplete list.
      await Promise.race([fetchSeriesEps(), sleep(timeout)]);
      scrapeEps();
    }
    return episodes.length;
  };

  const pickRandom = () => {
    const pool = episodes.filter(e => !sameURL(e.url, location.href));
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  };

  // ── Navigation: real page load, exactly like v4/original userscript ──────
  // A prior "soft navigation" approach (swapping the iframe's src to avoid
  // a full reload) was tried to keep fullscreen alive across episodes, but
  // it silently broke advancing: the top-level page's DOM (sidebar,
  // a[rel="next"], episode list) never actually refreshes under soft-nav,
  // so every subsequent "next" recomputed the SAME stale target and the
  // player got stuck replaying the same episode. Real navigation guarantees
  // a fresh, correct DOM every time — reliability here matters far more
  // than avoiding the fullscreen flash, which is instead handled by
  // "wantsFS" + maybeAutoFS() re-entering fullscreen on the next tap.
  // Fixed: never falls back to rel="prev" (that was the bug causing the
  // last episode to loop backward), and never wraps around to episode 1 —
  // if there's genuinely no next episode, this does nothing.
  // Tell a linked pop-out player to show its loading state right before
  // we actually navigate — its own document never reloads (that's the
  // whole point), so it needs an explicit heads-up that new content is on
  // the way, rather than just silently freezing on the last frame.
  const notifyPopoutLoading = () => {
    try { chrome.runtime.sendMessage({ type: 'WCO_POPOUT_LOADING' }); } catch {}
  };

  // Pure computation, no side effects — reused by goNext() and by the
  // WCO_GET_NEXT_URL handler below (which lets the pop-out cache this URL
  // as a last-resort fallback if the live sync connection stalls).
  const getNextEpisodeUrl = () => {
    const idx = episodes.findIndex(e => sameURL(e.url, location.href));
    if (idx >= 0 && idx + 1 < episodes.length) return episodes[idx + 1].url;
    const a = q('a[rel="next"]');
    return a?.href || null;
  };

  const goNext = () => {
    const url = getNextEpisodeUrl();
    if (url) { notifyPopoutLoading(); location.href = url; }
  };

  // Used by the embed player to decide whether to show the Next Episode /
  // Keep Watching pills at all — hides both once there's genuinely nothing
  // left to advance to.
  const hasNextEpisode = async () => {
    // The site's own "next" link is the most reliable signal — it's the
    // exact thing whose ABSENCE originally revealed this was the last
    // episode (see the goNext() fix above). Check it first.
    if (q('a[rel="next"]')) return true;
    // Fallback: consult our own scraped episode list, now that ensureEps()
    // actually waits for the full series fetch to complete.
    await ensureEps();
    const idx = episodes.findIndex(e => sameURL(e.url, location.href));
    if (idx >= 0) return idx + 1 < episodes.length;
    return false;
  };

  // Mirror of goNext()/hasNextEpisode() for the manual "previous episode"
  // arrow button. This is a plain, unconditional sequential-episode jump —
  // it deliberately ignores the navMode setting (Random mode doesn't
  // change what "previous episode" means).
  // Pure computation, mirror of getNextEpisodeUrl() — also handed to the
  // pop-out (as prevEpisodeUrl) so its "previous" button has a direct
  // URL to fall back to if this tab is frozen and can't act on WCO_GO_PREV.
  const getPrevEpisodeUrl = () => {
    const idx = episodes.findIndex(e => sameURL(e.url, location.href));
    if (idx > 0) return episodes[idx - 1].url;
    const a = q('a[rel="prev"]');
    return a?.href || null;
  };

  const goPrev = () => {
    const url = getPrevEpisodeUrl();
    if (url) { notifyPopoutLoading(); location.href = url; }
  };

  const hasPrevEpisode = async () => {
    if (q('a[rel="prev"]')) return true;
    await ensureEps();
    const idx = episodes.findIndex(e => sameURL(e.url, location.href));
    if (idx >= 0) return idx > 0;
    return false;
  };

  // The embed iframe is cross-origin from this page, so it can't read
  // document.title directly — it has to ask. document.title reliably
  // looks like "{Show} Episode {N} {Episode Title} English Dubbed/Subbed
  // - WCOFun - Watch Cartoons and Anime Online in HD for Free" across
  // every mirror site. This splits it into two display lines, matching
  // how streaming platforms usually lay this out: a small
  // "S1:E2 - Episode Title · Dub" line, and the show's own name shown
  // larger/bolder beneath it. Falls back to just the show name alone if
  // the Season/Episode pattern doesn't match for some title (never
  // leaves a blank line showing).
  const parseEpisodeTitle = () => {
    let t = (document.title || '').replace(/\s*-\s*(WCO\w*|Watch\s+Cartoons?).*/i, '').trim();

    const m = t.match(/^(.+?)\s+(?:Season\s+(\d+)\s+)?Episode\s+(\d+)\b\s*[:\-]?\s*(.*)$/i);
    if (!m) return { show: t, meta: '' };

    let [, show, season, ep, rest] = m;
    season = season || '1';

    // Capture dub/sub before stripping it out of the episode-title text,
    // so it can be shown as a short badge instead of just discarded.
    const dubSubMatch = rest.match(/\s*English\s+(Dubbed|Subbed)\s*$/i);
    const dubSub = dubSubMatch ? (/^Dub/i.test(dubSubMatch[1]) ? 'Dub' : 'Sub') : '';
    rest = rest.replace(/\s*English\s+(Dubbed|Subbed)\s*$/i, '').trim();

    let meta = rest ? `S${season}:E${ep} - ${rest}` : `S${season}:E${ep}`;
    if (dubSub) meta += ` · ${dubSub}`;
    return { show: show.trim(), meta };
  };

  const handleEnded = async () => {
    const prefs = await getPrefs();
    if (prefs.navMode === 'off') return;
    if (prefs.navMode === 'random') {
      await ensureEps();
      const ep = pickRandom();
      if (ep?.url) { notifyPopoutLoading(); location.href = ep.url; return; }
    }
    goNext();
  };

  const getIfr = () =>
    q('iframe[src*="vhs.wcostream.com"]') ||
    q('iframe[src*="embed.wcostream.com"]') ||
    q('iframe[data-type="wco-embed"]') ||
    q('#cizgi-js-0');

  window.addEventListener('message', async e => {
    if (e?.data?.type === 'WCO_VIDEO_ENDED') handleEnded();
    if (e?.data?.type === 'WCO_ENTER_FS') {
      const p = await getPrefs();
      if (!p.autoFullscreen) return;
      const ifr = getIfr();
      if (!ifr) return;
      const fn = ifr.requestFullscreen || ifr.webkitRequestFullscreen ||
                 ifr.mozRequestFullScreen || ifr.msRequestFullscreen;
      try { fn?.call(ifr); } catch {}
    }
    if (e?.data?.type === 'WCO_CHECK_NEXT') {
      const hasNext = await hasNextEpisode();
      try { e.source.postMessage({ type: 'WCO_NEXT_INFO', hasNext }, '*'); } catch {}
    }
    if (e?.data?.type === 'WCO_CHECK_PREV') {
      const hasPrev = await hasPrevEpisode();
      try { e.source.postMessage({ type: 'WCO_PREV_INFO', hasPrev }, '*'); } catch {}
    }
    if (e?.data?.type === 'WCO_GET_TITLE') {
      const { show, meta } = parseEpisodeTitle();
      try { e.source.postMessage({ type: 'WCO_TITLE_INFO', show, meta }, '*'); } catch {}
    }
    if (e?.data?.type === 'WCO_GET_NEXT_URL') {
      // Answer right away with whatever is known, then again once the full
      // series list has loaded (the sidebar is often only partial at first),
      // so the pop-out's fallback URLs are as accurate as possible.
      const reply = () => { try { e.source.postMessage({ type: 'WCO_NEXT_URL_INFO', url: getNextEpisodeUrl(), prevUrl: getPrevEpisodeUrl() }, '*'); } catch {} };
      reply();
      await ensureEps();
      reply();
    }
    if (e?.data?.type === 'WCO_GO_NEXT') goNext();
    if (e?.data?.type === 'WCO_GO_PREV') goPrev();
  });

  const maybeRestoreFS = async () => {
    if (sessionStorage.getItem(FS_KEY) !== '1') return;
    const p = await getPrefs();
    if (!p.autoFullscreen) { sessionStorage.removeItem(FS_KEY); return; }
    let ifr = null;
    for (let i = 0; i < 50 && !ifr; i++) { ifr = getIfr(); if (!ifr) await sleep(250); }
    if (!ifr) return;
    await sleep(1000);
    sessionStorage.removeItem(FS_KEY);
    const fn = ifr.requestFullscreen || ifr.webkitRequestFullscreen ||
               ifr.mozRequestFullScreen || ifr.msRequestFullscreen;
    try { fn?.call(ifr); } catch {}
  };

  const fixIframe = () => {
    qa('iframe').forEach(ifr => {
      try {
        const cur = (ifr.getAttribute('allow') || '').toLowerCase();
        let val = cur;
        if (!val.includes('autoplay'))   val += '; autoplay';
        if (!val.includes('fullscreen')) val += '; fullscreen';
        ifr.setAttribute('allow', val.replace(/^;\s*/,'').trim());
      } catch {}
    });
  };

  chrome.runtime.onMessage.addListener(req => {
    if (req.action === 'PLAY_RANDOM_NOW') {
      ensureEps(3000).then(() => { const ep = pickRandom(); if (ep?.url) location.href = ep.url; });
    }
  });

  // Relay the pop-out's navigation-related requests to the same
  // functions the real "prev/next" arrows already use — reuses all the
  // same reliable logic, no duplication needed.
  //
  // Registered UNCONDITIONALLY (not gated behind a one-time "is a pop-out
  // linked?" check) for the exact same reason as the embed side: that
  // check runs at page-load time, before the user has necessarily
  // (re)opened a pop-out on THIS episode's fresh page load, so it would
  // always say "no" and these listeners would never get registered at
  // all. That silently broke WCO_CHECK_NEXT/WCO_CHECK_PREV — with nobody
  // listening, the pop-out's callback received no response, which its
  // code (correctly, defensively) treated as "no episode available,"
  // hiding the Next Episode pill and arrows entirely. Registering
  // unconditionally is harmless: it simply never fires if there's no
  // pop-out to ask.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'WCO_CHECK_NEXT') {
      hasNextEpisode().then(hasNext => sendResponse({ hasNext }));
      return true;
    }
    if (msg?.type === 'WCO_CHECK_PREV') {
      hasPrevEpisode().then(hasPrev => sendResponse({ hasPrev }));
      return true;
    }
    if (msg?.type === 'WCO_GO_NEXT') { goNext(); return; }
    if (msg?.type === 'WCO_GO_PREV') { goPrev(); return; }
    // The pop-out's own countdown reached 0 (or its video ended
    // naturally) while handed off — the site's own video is paused the
    // whole time, so its timeupdate-driven countdown never ticks and
    // would never fire this on its own. Route through the SAME
    // handleEnded() used for normal end-of-video, so Random mode still
    // picks a real random episode instead of always just going next.
    if (msg?.type === 'WCO_POPOUT_EPISODE_ENDED') { handleEnded(); return; }
  });

  const boot = () => {
    scrapeEps(); fetchSeriesEps(); fixIframe(); maybeRestoreFS();
    new MutationObserver(() => {
      fixIframe();
      if (sessionStorage.getItem(FS_KEY) === '1') maybeRestoreFS();
    }).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

})();