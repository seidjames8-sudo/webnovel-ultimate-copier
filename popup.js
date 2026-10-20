/*
 * WebNovel Chapter Copier - popup controller.
 * Talks to the active tab's content script; stores preferences in chrome.storage.local.
 */
const $ = (id) => document.getElementById(id);
const BUILTIN_URL = /^https?:\/\/([a-z0-9-]+\.)*(webnovel\.com)\//i;
const PREVIEW_LIMIT = 4000;

let tabId = null;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function hostMatches(hostname, host) {
  return hostname === host || hostname.endsWith('.' + host);
}

async function loadCustomSites() {
  const stored = await chrome.storage.local.get({ customSites: [] });
  return Array.isArray(stored.customSites) ? stored.customSites : [];
}

function isSupportedUrl(url, customSites) {
  if (!url) return false;
  if (BUILTIN_URL.test(url)) return true;
  try {
    const hostname = new URL(url).hostname;
    return customSites.some(site => hostMatches(hostname, site.host));
  } catch (_) {
    return false;
  }
}

function send(message) {
  if (tabId == null) return Promise.reject(new Error('No active tab'));
  return chrome.tabs.sendMessage(tabId, message);
}

function say(text, kind = '') {
  const node = $('message');
  node.textContent = text;
  node.className = 'message ' + kind;
}

function setChapterControlsEnabled(enabled) {
  ['copyBtn', 'selectBtn', 'plainBtn', 'paraBtn', 'previewBtn'].forEach(id => {
    $(id).disabled = !enabled;
  });
}

function setPill(on) {
  const pill = $('pill');
  pill.textContent = on ? 'ON' : 'OFF';
  pill.className = 'pill ' + (on ? 'on' : 'off');
}

function render(status) {
  $('title').textContent = status.supported ? (status.title || 'Chapter') : 'No chapter detected';
  $('chars').textContent = status.chars.toLocaleString();
  $('paras').textContent = status.paragraphs.toLocaleString();
  $('detected').textContent = status.supported ? 'Yes' : 'No';
  $('statusLine').textContent = status.message || '';
  $('autoStatus').textContent = status.autoCopy ? 'Auto-Copy: ON' : 'Auto-Copy: OFF';
  $('autoToggle').checked = !!status.autoCopy;
  $('ctrlAToggle').checked = !!status.ctrlA;
  $('notifToggle').checked = !!status.notifications;
  $('format').value = status.format;
  setPill(!!status.autoCopy);
  setChapterControlsEnabled(!!status.supported);
  $('retryBtn').disabled = false;

  if (!status.supported && status.error) {
    $('statusLine').textContent = status.error;
  } else if (status.code === 'failed' && status.message) {
    $('statusLine').textContent = status.message;
  }
}

function renderUnavailable(title, statusText) {
  $('title').textContent = title;
  $('statusLine').textContent = statusText;
  $('chars').textContent = '0';
  $('paras').textContent = '0';
  $('detected').textContent = 'No';
  setChapterControlsEnabled(false);
  $('retryBtn').disabled = true;
  $('autoToggle').disabled = true;
  $('ctrlAToggle').disabled = true;
}

async function refresh() {
  const tab = await getActiveTab();
  tabId = tab ? tab.id : null;
  const customSites = await loadCustomSites();
  const onSite = !!tab && isSupportedUrl(tab.url || '', customSites);

  let siteLabel = 'Not a supported site';
  try {
    if (tab && tab.url) siteLabel = new URL(tab.url).hostname;
  } catch (_) { /* ignore */ }
  $('site').textContent = onSite ? siteLabel : 'Not a supported site';
  $('autoToggle').disabled = !onSite;
  $('ctrlAToggle').disabled = !onSite;

  if (!onSite) {
    renderUnavailable('Open a supported chapter', 'Unsupported page. Add this site under Settings > Custom sites.');
    return;
  }

  let status;
  try {
    status = await send({ type: 'WCC_STATUS' });
  } catch (_) {
    renderUnavailable('Extension not active on this page', 'Reload the chapter page to activate the extension');
    return;
  }
  if (!status || !status.ok) {
    renderUnavailable('Unable to read this page', 'Reload the chapter page and try again');
    return;
  }
  $('autoToggle').disabled = false;
  $('ctrlAToggle').disabled = false;
  render(status);
}

async function doCopy(format) {
  say('Copying…');
  try {
    const result = await send({ type: 'WCC_COPY', format });
    if (result && result.ok) {
      say(`Copied "${result.title}": ${result.chars.toLocaleString()} characters, ${result.paragraphs} paragraphs.`, 'success');
    } else {
      say((result && result.error) || 'Copy failed.', 'error');
    }
  } catch (_) {
    say('Could not reach the chapter page. Reload it and try again.', 'error');
  }
  refresh();
}

async function doSelect() {
  try {
    const result = await send({ type: 'WCC_SELECT' });
    if (result && result.ok) say('Chapter text selected on the page.', 'success');
    else say((result && result.error) || 'Selection failed.', 'error');
  } catch (_) {
    say('Could not reach the chapter page. Reload it and try again.', 'error');
  }
}

async function doRetry() {
  say('Retrying extraction…');
  try {
    const result = await send({ type: 'WCC_RETRY' });
    if (result && result.ok) {
      say(result.message || `Chapter detected: ${result.chars.toLocaleString()} characters.`, 'success');
    } else {
      say((result && result.error) || 'Extraction failed.', 'error');
    }
  } catch (_) {
    say('Could not reach the chapter page. Reload it and try again.', 'error');
  }
  refresh();
}

async function doPreview() {
  const panel = $('previewPanel');
  if (!panel.hidden) {
    panel.hidden = true;
    return;
  }
  try {
    const result = await send({ type: 'WCC_EXTRACT' });
    if (!result || !result.ok) {
      say((result && result.error) || 'Preview unavailable.', 'error');
      return;
    }
    const full = result.paragraphs.join('\n\n');
    const shown = full.slice(0, PREVIEW_LIMIT);
    const truncated = full.length > shown.length;
    $('previewMeta').textContent =
      `${result.title} · ${result.chars.toLocaleString()} characters · ${result.paragraphs.length} paragraphs`;
    $('previewText').textContent = shown + (truncated
      ? '\n\n… Preview truncated. Copy includes the full chapter.'
      : '');
    panel.hidden = false;
  } catch (_) {
    say('Could not reach the chapter page. Reload it and try again.', 'error');
  }
}

// ---- Custom sites ----

function renderSiteList(sites) {
  const list = $('siteList');
  list.textContent = '';
  if (!sites.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No custom sites added yet.';
    empty.style.color = 'var(--muted)';
    list.appendChild(empty);
    return;
  }
  for (const site of sites) {
    const item = document.createElement('li');
    const info = document.createElement('span');
    info.textContent = site.host;
    const detail = document.createElement('small');
    detail.textContent = site.pattern ? 'Chapter pattern: ' + site.pattern : 'Any page with chapter text';
    info.appendChild(detail);
    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => removeSite(site.host));
    item.append(info, removeBtn);
    list.appendChild(item);
  }
}

async function syncBackground() {
  return chrome.runtime.sendMessage({ type: 'WCC_SYNC_SITES' }).catch(() => null);
}

async function addSite() {
  const raw = $('siteUrl').value.trim();
  const pattern = $('sitePattern').value.trim();

  let url;
  try {
    url = new URL(raw.includes('://') ? raw : 'https://' + raw);
  } catch (_) {
    say('Enter a valid site address, for example https://example-novel.com', 'error');
    return;
  }
  const host = url.hostname.toLowerCase();
  if (!host.includes('.')) {
    say('Enter a full site address with a domain name.', 'error');
    return;
  }
  if (pattern) {
    try {
      new RegExp(pattern, 'i');
    } catch (_) {
      say('The chapter pattern is not a valid regular expression.', 'error');
      return;
    }
  }

  // Must stay the first asynchronous step so Chrome treats it as a user gesture.
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [`*://*.${host}/*`] });
  } catch (err) {
    say('Could not request permission: ' + err.message, 'error');
    return;
  }
  if (!granted) {
    say(`Permission for ${host} was not granted, so the site was not added.`, 'error');
    return;
  }

  const sites = await loadCustomSites();
  const existing = sites.find(s => s.host === host);
  if (existing) existing.pattern = pattern;
  else sites.push({ host, pattern });
  await chrome.storage.local.set({ customSites: sites });
  await syncBackground();

  // Inject into the current tab if it is on this site, so no reload is needed.
  const tab = await getActiveTab();
  if (tab && tab.id != null && tab.url) {
    try {
      if (hostMatches(new URL(tab.url).hostname, host)) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      }
    } catch (_) { /* page may not allow injection; reload will fix it */ }
  }

  $('siteUrl').value = '';
  $('sitePattern').value = '';
  renderSiteList(sites);
  say(`Added ${host}. If it does not respond, reload the chapter page.`, 'success');
  refresh();
}

async function removeSite(host) {
  const sites = (await loadCustomSites()).filter(s => s.host !== host);
  await chrome.storage.local.set({ customSites: sites });
  try {
    await chrome.permissions.remove({ origins: [`*://*.${host}/*`] });
  } catch (_) { /* permission may already be gone */ }
  await syncBackground();
  renderSiteList(sites);
  say(`Removed ${host}.`, 'success');
  refresh();
}

function bindEvents() {
  $('copyBtn').addEventListener('click', () => doCopy($('format').value));
  $('plainBtn').addEventListener('click', () => doCopy('plain'));
  $('paraBtn').addEventListener('click', () => doCopy('paragraph'));
  $('previewCopyBtn').addEventListener('click', () => doCopy('paragraph'));
  $('selectBtn').addEventListener('click', doSelect);
  $('retryBtn').addEventListener('click', doRetry);
  $('previewBtn').addEventListener('click', doPreview);
  $('addSiteBtn').addEventListener('click', addSite);

  $('titleToggle').addEventListener('change', (event) => {
    chrome.storage.local.set({ includeTitle: event.target.checked });
    say(event.target.checked ? 'Chapter title will be included.' : 'Chapter title will be left out.', 'success');
  });

  $('timeoutSeconds').addEventListener('change', (event) => {
    const seconds = Math.min(120, Math.max(5, Math.round(Number(event.target.value) || 25)));
    event.target.value = seconds;
    chrome.storage.local.set({ extractionTimeoutMs: seconds * 1000 });
  });

  $('autoToggle').addEventListener('change', async (event) => {
    const on = event.target.checked;
    await chrome.storage.local.set({ autoCopy: on });
    say(on ? 'Auto-Copy enabled.' : 'Auto-Copy disabled.', 'success');
    setTimeout(refresh, 300);
  });

  $('ctrlAToggle').addEventListener('change', async (event) => {
    await chrome.storage.local.set({ ctrlA: event.target.checked });
    say(event.target.checked
      ? 'Ctrl + A now selects only the chapter on supported chapter pages.'
      : 'Ctrl + A restored to normal browser behavior.', 'success');
  });

  $('notifToggle').addEventListener('change', (event) => {
    chrome.storage.local.set({ notifications: event.target.checked });
  });

  $('format').addEventListener('change', (event) => {
    chrome.storage.local.set({ format: event.target.value === 'plain' ? 'plain' : 'paragraph' });
  });
}

async function loadEngineInfo() {
  try {
    const info = await chrome.runtime.sendMessage({ type: 'WCC_ENGINE_INFO' });
    if (info && info.backend === 'wasm') {
      $('engineInfo').textContent = 'Text engine: Rust/WASM';
    } else {
      const reason = info && info.error ? ' (' + info.error + ')' : '';
      $('engineInfo').textContent = 'Text engine: JavaScript fallback' + reason;
    }
  } catch (_) {
    $('engineInfo').textContent = 'Text engine: unavailable';
  }
}

async function init() {
  bindEvents();

  const stored = await chrome.storage.local.get({
    autoCopy: false, ctrlA: false, notifications: true, format: 'paragraph',
    includeTitle: true, extractionTimeoutMs: 25000
  });
  $('autoToggle').checked = !!stored.autoCopy;
  $('ctrlAToggle').checked = !!stored.ctrlA;
  $('titleToggle').checked = stored.includeTitle !== false;
  $('notifToggle').checked = !!stored.notifications;
  $('timeoutSeconds').value = Math.round(stored.extractionTimeoutMs / 1000);
  $('format').value = stored.format === 'plain' ? 'plain' : 'paragraph';
  setPill(!!stored.autoCopy);

  renderSiteList(await loadCustomSites());
  loadEngineInfo();
  await refresh();
  setInterval(refresh, 1500);
}

init().catch(err => say('Unexpected error: ' + err.message, 'error'));
