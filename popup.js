document.addEventListener('DOMContentLoaded', () => {
  // ── Existing settings ──────────────────────────────────────────────────
  chrome.storage.local.get({
    navMode: 'next', autoFullscreen: false, popoutAutoFullscreen: false,
    leadMode: 'disabled', leadTimeCustom: 60,
    countdownDuration: 10
  }, items => {
    const nav = document.querySelector(`input[name="navMode"][value="${items.navMode}"]`);
    if (nav) nav.checked = true;
    document.getElementById('autoFullscreen').checked = items.autoFullscreen;
    document.getElementById('popoutAutoFullscreen').checked = items.popoutAutoFullscreen;

    // Countdown select — Disabled(0) / 5 / 10 / 15 only, no custom
    document.getElementById('countdownSelect').value = String(items.countdownDuration || 0);

    // Show prompt at — Disabled / Custom only
    const leadSelect = document.getElementById('leadModeSelect');
    const leadCustom = document.getElementById('leadTimeCustomWrap');
    const leadInput  = document.getElementById('leadTimeCustomInput');
    leadSelect.value = items.leadMode;
    if (items.leadMode === 'custom') {
      leadCustom.classList.add('show');
      leadInput.value = items.leadTimeCustom;
    }
  });

  document.querySelectorAll('input[name="navMode"]').forEach(r => {
    r.addEventListener('change', () => { if (r.checked) chrome.storage.local.set({ navMode: r.value }); });
  });

  document.getElementById('autoFullscreen').addEventListener('change', e => {
    chrome.storage.local.set({ autoFullscreen: e.target.checked });
    if (!e.target.checked) chrome.storage.local.set({ wantsFS: false });
  });

  document.getElementById('popoutAutoFullscreen').addEventListener('change', e => {
    chrome.storage.local.set({ popoutAutoFullscreen: e.target.checked });
  });

  // ── Next Episode Timing ──────────────────────────────────────────────────
  // Countdown: Disabled(0) / 5 / 10 / 15 — no custom option, matches the
  // simplified player-side control exactly (they share the same pref).
  document.getElementById('countdownSelect').addEventListener('change', e => {
    chrome.storage.local.set({ countdownDuration: parseInt(e.target.value, 10) });
  });

  // Show prompt at: Disabled / Custom — the "advanced" one, extension-only.
  const leadSelect = document.getElementById('leadModeSelect');
  const leadCustom = document.getElementById('leadTimeCustomWrap');
  const leadInput  = document.getElementById('leadTimeCustomInput');

  leadSelect.addEventListener('change', () => {
    const mode = leadSelect.value;
    chrome.storage.local.set({ leadMode: mode });
    if (mode === 'custom') {
      leadCustom.classList.add('show');
      leadInput.focus();
    } else {
      leadCustom.classList.remove('show');
    }
  });
  leadInput.addEventListener('change', () => {
    let v = parseInt(leadInput.value, 10);
    if (!v || v < 1) return;
    v = Math.min(300, v);
    leadInput.value = v;
    chrome.storage.local.set({ leadTimeCustom: v });
  });

  document.getElementById('btn-random-now').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, { action: 'PLAY_RANDOM_NOW' });
    });
  });

  document.getElementById('btn-popout').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]?.id != null) chrome.runtime.sendMessage({ action: 'OPEN_POPOUT', tabId: tabs[0].id });
    });
  });

  // ── Browser autoplay-help accordion ─────────────────────────────────────
  const helpToggle = document.getElementById('help-toggle');
  const helpBody   = document.getElementById('help-body');
  helpToggle.addEventListener('click', () => {
    helpToggle.classList.toggle('open');
    helpBody.classList.toggle('open');
  });

  const STEPS = {
    chrome: {
      steps: [
        'Click the padlock (or tune) icon at the left of the address bar.',
        'Click "Site settings".',
        'Find "Sound" in the list and set it to "Allow".',
        'Reload the page.'
      ],
      note: 'If it still doesn\u2019t play with sound, repeat these steps while a video is open inside the player itself \u2014 some Chrome versions apply this per-frame, not just per-site.'
    },
    firefox: {
      steps: [
        'Click the padlock icon at the left of the address bar.',
        'Click the arrow next to "Connection secure", then "More Information".',
        'Go to the "Permissions" tab.',
        'Uncheck "Use Default" next to Autoplay, then set it to "Allow Audio and Video".',
        'Reload the page.'
      ],
      note: 'You can also manage this globally under Settings \u2192 Privacy & Security \u2192 Permissions \u2192 Autoplay \u2192 Settings.'
    },
    edge: {
      steps: [
        'Click the padlock icon at the left of the address bar.',
        'Click "Permissions for this site".',
        'Find "Media autoplay" and set it to "Allow".',
        'Reload the page.'
      ],
      note: ''
    },
    safari: {
      steps: [
        'Open Safari\u2019s menu bar \u2192 Settings (or Preferences) \u2192 Websites.',
        'Select "Auto-Play" from the left sidebar.',
        'Find this site in the list (or set "When visiting other websites") and choose "Allow All Auto-Play".',
        'Reload the page.'
      ],
      note: 'On iOS Safari, autoplay with sound from websites is restricted system-wide and can\u2019t be changed per-site \u2014 the muted-then-unmute trick this extension uses is the best available workaround there.'
    },
    brave: {
      steps: [
        'Click the padlock icon at the left of the address bar.',
        'Click "Site settings".',
        'Find "Sound" and set it to "Allow".',
        'Also check the Brave Shields icon (the lion) \u2014 lower Shields to "Standard" for this site if media still won\u2019t play.',
        'Reload the page.'
      ],
      note: ''
    },
    opera: {
      steps: [
        'Click the padlock icon at the left of the address bar.',
        'Click "Site settings".',
        'Find "Sound" and set it to "Allow".',
        'Reload the page.'
      ],
      note: ''
    }
  };

  const stepsEl = document.getElementById('browser-steps');
  const noteEl  = document.getElementById('browser-note');
  const chips   = document.querySelectorAll('.browser-chip');

  const renderBrowser = (key) => {
    chips.forEach(c => c.classList.toggle('active', c.dataset.b === key));
    const data = STEPS[key];
    stepsEl.textContent = ''; // clear previous steps
    data.steps.forEach(s => {
      const li = document.createElement('li');
      li.textContent = s;
      stepsEl.appendChild(li);
    });
    noteEl.textContent = data.note || '';
  };

  chips.forEach(chip => {
    chip.addEventListener('click', () => renderBrowser(chip.dataset.b));
  });

  // Best-effort auto-detect so the right tab is pre-selected
  const ua = navigator.userAgent;
  let detected = 'chrome';
  if (/Edg\//.test(ua)) detected = 'edge';
  else if (/OPR\//.test(ua) || /Opera/.test(ua)) detected = 'opera';
  else if (/Brave/.test(ua) || (navigator.brave && navigator.brave.isBrave)) detected = 'brave';
  else if (/Firefox\//.test(ua)) detected = 'firefox';
  else if (/^((?!chrome|android).)*safari/i.test(ua)) detected = 'safari';
  else if (/Chrome\//.test(ua)) detected = 'chrome';

  renderBrowser(detected);
});
