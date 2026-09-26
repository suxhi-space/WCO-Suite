/* =================================================================
   WCO Suite – background.js v1.0.32

   Tracks a single active pop-out player and its linked source tab.
   Content scripts talk to the pop-out DIRECTLY via chrome.tabs /
   chrome.runtime messaging — this background script's job is just:
     1. Open/close the pop-out window (content scripts can't call
        chrome.windows.* themselves)
     2. Remember which tab is the "source" for the current pop-out
     3. Answer "is popout linked to me?" queries from content scripts
     4. Clean up on either side closing, AND tell the OTHER side —
        this is what makes the source tab correctly resume playback
        when the pop-out is closed.

   IMPORTANT — persisted AND self-verifying, not a plain variable:
   Manifest V3 service workers are NOT long-lived. The browser can and
   does terminate them after a short period of inactivity, restarting
   them fresh the next time a message/event arrives — a plain
   `let popout = null` variable doesn't survive that. storage.local
   does. But persistence alone isn't quite enough either — closing the
   pop-out window (especially via the OS window controls rather than
   our own in-app button) doesn't always reliably fire
   chrome.windows.onRemoved in every browser/platform, which left the
   stored state stale even with persistence in place. So getPopout()
   below doesn't just read the stored reference — it actively confirms
   the window still exists via chrome.windows.get() every time anything
   asks, and self-heals if it doesn't. This means even if onRemoved
   never fires for some reason, the very next status check (which
   happens frequently — every reconnect attempt, every fresh page load)
   corrects it, rather than staying wrong indefinitely.

   (storage.local rather than storage.session on purpose: session was
   only added to Firefox in version 115, and this extension's declared
   minimum supported Firefox version predates that — local works
   identically everywhere. The only difference, local surviving a full
   browser restart, is harmless here: a stale leftover reference just
   fails silently the moment anything tries to act on it, and
   onStartup below clears it anyway.)
================================================================= */

const getPopout = () => new Promise(resolve => {
  chrome.storage.local.get({ popout: null }, (r) => {
    const p = r.popout;
    if (!p) { resolve(null); return; }
    chrome.windows.get(p.windowId, () => {
      if (chrome.runtime.lastError) {
        // Window doesn't actually exist — stale reference, clean it up.
        chrome.storage.local.set({ popout: null });
        resolve(null);
      } else {
        resolve(p);
      }
    });
  });
});
const setPopout = (value) => chrome.storage.local.set({ popout: value });

chrome.runtime.onStartup.addListener(() => setPopout(null));

const notifySourceDisconnected = (tabId) => {
  if (tabId == null) return;
  try { chrome.tabs.sendMessage(tabId, { type: 'WCO_POPOUT_DISCONNECTED' }); } catch {}
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ── Open the pop-out player, linked to whichever tab asked ──────────────
  if (msg?.action === 'OPEN_POPOUT') {
    const sourceTabId = sender?.tab?.id ?? msg.tabId;
    if (sourceTabId == null) return;

    (async () => {
      // Only one pop-out at a time for now — close any existing one first.
      const existing = await getPopout();
      if (existing) {
        try { chrome.windows.remove(existing.windowId); } catch {}
        await setPopout(null);
      }

      // A little smaller than full screen, fixed 16:9 shape by default.
      const url = chrome.runtime.getURL(`popout-player.html?sourceTab=${sourceTabId}`);
      chrome.windows.create({ url, type: 'popup', width: 960, height: 540 }, async (win) => {
        await setPopout({ windowId: win.id, sourceTabId });
      });
    })();
    return true;
  }

  // ── The pop-out page asks "which tab am I mirroring?" on load ──────────
  if (msg?.type === 'WCO_POPOUT_WHOAMI') {
    getPopout().then(p => sendResponse({ sourceTabId: p?.sourceTabId ?? null }));
    return true;
  }

  // ── A content script asks "is there a pop-out linked to me?" ───────────
  if (msg?.type === 'WCO_POPOUT_STATUS_QUERY') {
    getPopout().then(p => {
      const isSource = !!p && sender?.tab?.id === p.sourceTabId;
      sendResponse({ active: isSource });
    });
    return true;
  }

  // ── The pop-out page itself is closing — tell the source tab so it can
  // resume local playback instead of sitting paused forever. ─────────────
  if (msg?.type === 'WCO_POPOUT_CLOSING') {
    getPopout().then(async p => {
      notifySourceDisconnected(p?.sourceTabId);
      await setPopout(null);
    });
    return true;
  }
});

// Clean up if the pop-out window is closed via the OS window controls
// (X button, Alt+F4, etc.) rather than our own beforeunload handler.
chrome.windows.onRemoved.addListener((windowId) => {
  getPopout().then(async p => {
    if (p && p.windowId === windowId) {
      notifySourceDisconnected(p.sourceTabId);
      await setPopout(null);
    }
  });
});

// Clean up if the source tab itself is closed — nothing left to mirror.
chrome.tabs.onRemoved.addListener((tabId) => {
  getPopout().then(async p => {
    if (p && p.sourceTabId === tabId) await setPopout(null);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Per-tab icon + popup: grayed out with a "not supported here" popup on
// any site outside our supported list, full color + normal settings
// popup everywhere else.
// ══════════════════════════════════════════════════════════════════════
const SUPPORTED_HOST_RE = new RegExp(
  '^https://([^/]*\\.)?(' +
  ['wco\\.tv','wcostream\\.tv','wcoflix\\.tv','wcoanimesub\\.tv',
   'wcoanimedub\\.tv','wcoforever\\.net','watchcartoononline\\.com',
   'embed\\.wcostream\\.com'].join('|') +
  ')(/|$)'
);

const updateActionForTab = (tabId, url) => {
  const supported = !!url && SUPPORTED_HOST_RE.test(url);
  const size = { 16: 'icons/icon16', 32: 'icons/icon32', 48: 'icons/icon48', 128: 'icons/icon128' };
  const suffix = supported ? '.png' : '-inactive.png';
  chrome.action.setIcon({
    tabId,
    path: Object.fromEntries(Object.entries(size).map(([k, v]) => [k, v + suffix]))
  });
  chrome.action.setPopup({ tabId, popup: supported ? 'popup.html' : 'unsupported.html' });
};

const refreshTab = (tabId) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    updateActionForTab(tabId, tab.url);
  });
};

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'complete') refreshTab(tabId);
});
chrome.tabs.onActivated.addListener(({ tabId }) => refreshTab(tabId));
