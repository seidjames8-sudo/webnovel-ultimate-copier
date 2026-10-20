/*
 * WebNovel Chapter Copier - background service worker
 * - Relays keyboard commands to the active tab's content script.
 * - Writes to the clipboard through an offscreen document when needed.
 * - Keeps content scripts for user-added custom sites registered.
 */

const COMMAND_ACTIONS = {
  'copy-chapter': 'copy',
  'select-chapter': 'select',
  'retry-chapter': 'retry'
};

const CUSTOM_PREFIX = 'wcc-custom-';

chrome.commands.onCommand.addListener(async (command) => {
  const action = COMMAND_ACTIONS[command];
  if (!action) return;

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id == null) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'WCC_COMMAND', command: action });
  } catch (_) {
    // Not a supported page, or the content script is not loaded yet.
  }
});

// ---- Custom site registration ----

let syncChain = Promise.resolve();

function syncCustomSites() {
  syncChain = syncChain.then(doSyncCustomSites, doSyncCustomSites);
  return syncChain;
}

async function doSyncCustomSites() {
  const stored = await chrome.storage.local.get({ customSites: [] });
  const sites = Array.isArray(stored.customSites) ? stored.customSites : [];

  const registered = await chrome.scripting.getRegisteredContentScripts();
  const oldIds = registered.filter(s => s.id.startsWith(CUSTOM_PREFIX)).map(s => s.id);
  if (oldIds.length) {
    await chrome.scripting.unregisterContentScripts({ ids: oldIds });
  }

  const scripts = [];
  for (const site of sites) {
    const matches = [`*://*.${site.host}/*`];
    const granted = await chrome.permissions.contains({ origins: matches });
    if (!granted) continue;
    scripts.push({
      id: CUSTOM_PREFIX + site.host.replace(/[^a-z0-9]/gi, '-'),
      matches,
      js: ['content.js'],
      runAt: 'document_idle',
      allFrames: false,
      persistAcrossSessions: true
    });
  }
  if (scripts.length) {
    await chrome.scripting.registerContentScripts(scripts);
  }
  return { ok: true, count: scripts.length };
}

chrome.runtime.onStartup.addListener(() => { syncCustomSites().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { syncCustomSites().catch(() => {}); });

// ---- Clipboard via offscreen document ----

async function ensureOffscreenDocument() {
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Copy extracted chapter text to the clipboard.'
    });
  } catch (err) {
    if (!/single|already/i.test(String(err && err.message))) throw err;
  }
}

async function writeClipboardViaOffscreen(text) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'WCC_WRITE',
    text
  });
  return response || { ok: false, error: 'No response from clipboard helper.' };
}

// ---- Messages ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message) return false;
  if (message.target === 'offscreen') return false;

  if (message.type === 'WCC_CLIPBOARD' && typeof message.text === 'string') {
    writeClipboardViaOffscreen(message.text)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  if (message.type === 'WCC_ENGINE_INFO') {
    ensureOffscreenDocument()
      .then(() => chrome.runtime.sendMessage({ target: 'offscreen', type: 'WCC_ENGINE_INFO' }))
      .then(sendResponse)
      .catch(err => sendResponse({ backend: 'unknown', error: String(err && err.message || err) }));
    return true;
  }

  if (message.type === 'WCC_SYNC_SITES') {
    syncCustomSites()
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  return false;
});
