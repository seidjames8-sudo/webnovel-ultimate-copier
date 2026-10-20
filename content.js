/*
 * WebNovel Chapter Copier - content script
 * Runs on WebNovel and on custom sites the user adds. All processing happens locally in the page.
 */
(() => {
  'use strict';
  if (window.__wccContentLoaded) return;
  window.__wccContentLoaded = true;

  // ---------------------------------------------------------------------------
  // CONFIGURATION. If WebNovel changes its markup, update these selectors.
  // Each list is tried in order; the first selector that matches visible
  // content wins. Reload the extension after editing this file.
  // ---------------------------------------------------------------------------
  const CONFIG = {
    contentSelectors: [
      '.cha-content',
      '.cha-words',
      '#chapter-content',
      '.chapter-content',
      '[class*="cha-content"]',
      '[class*="chapter-content"]'
    ],
    titleSelectors: [
      '.cha-tit h3',
      'h3.cha-tit',
      '.cha-tit',
      '.chapter-title',
      '[class*="chapter-title"]',
      'h1'
    ],
    nextSelectors: [
      '.cha-nav a.cha-next',
      'a.cha-next',
      '[class*="cha-next"]',
      'a[rel="next"]'
    ],
    // Link text used for next-chapter detection on sites without a stable class.
    nextLinkText: /下一章|下一页|next chapter|next/i,
    excludeSelectors: [
      'script', 'style', 'noscript', 'template', 'iframe', 'svg',
      'button', 'nav', 'header', 'footer', 'aside', 'form',
      '[hidden]', '[aria-hidden="true"]',
      '.ad', '.ads', '[class*="advert"]', '[id*="advert"]',
      '[class*="comment"]', '[class*="recommend"]',
      '[class*="cha-nav"]', '[class*="copyright"]'
    ],
    // Chapter URL patterns for each supported site:
    //   WebNovel: /book/<novel-slug>/<chapter-id>
    chapterPathPatterns: [
      /\/book\/[^/]+\/[^/?#]+/i
    ],
    minChars: 100,        // below this, extraction is treated as incomplete
    stableMs: 1000,       // content must stay unchanged this long before extraction
    timeoutMs: 25000,     // give up waiting for a new chapter after this long
    pollMs: 500,
    debounceMs: 200
  };

  const settings = {
    autoCopy: false,
    ctrlA: false,
    notifications: true,
    format: 'paragraph',
    includeTitle: true
  };

  function buildSelectors(overrides) {
    const merge = (key) => [...new Set([...(overrides[key] || []), ...CONFIG[key]])];
    return {
      contentSelectors: merge('contentSelectors'),
      titleSelectors: merge('titleSelectors'),
      nextSelectors: merge('nextSelectors'),
      excludeSelectors: CONFIG.excludeSelectors
    };
  }

  let SEL = buildSelectors({});

  // ---------------------------------------------------------------------------
  // Runtime state (per tab, lives with this page)
  // ---------------------------------------------------------------------------
  let navToken = 0;              // increments on every navigation; stale work checks it
  let lastHandledId = null;      // chapter id last processed by the watcher
  let lastHref = location.href;
  let lastCopiedKey = null;      // id|signature of the last chapter copied
  let pending = null;            // { data, text } waiting for a user-initiated Copy Now
  let statusCache = null;        // cached extraction for popup status
  let state = { code: 'idle', message: 'Waiting for a chapter' };
  let lastToast = { msg: '', at: 0 };

  const ss = {
    get(key) { try { return sessionStorage.getItem(key); } catch (_) { return null; } },
    set(key, value) { try { sessionStorage.setItem(key, value); } catch (_) { /* ignore */ } }
  };

  function setState(code, message) {
    state = { code, message };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  // Custom sites added by the user: { host, pattern } where pattern is an
  // optional regex matched against the URL path.
  let customSites = [];

  function customEntryFor(hostname) {
    return customSites.find(site => hostname === site.host || hostname.endsWith('.' + site.host)) || null;
  }

  function chapterIdFromHref(href) {
    try {
      const url = new URL(href, location.href);
      const path = url.pathname;
      if (CONFIG.chapterPathPatterns.some(re => re.test(path))) {
        return path.replace(/\/+$/, '');
      }
      const entry = customEntryFor(url.hostname);
      if (!entry) return null;
      if (entry.pattern) {
        let re;
        try {
          re = new RegExp(entry.pattern, 'i');
        } catch (_) {
          return null;
        }
        if (!re.test(path)) return null;
      }
      return path.replace(/\/+$/, '') || '/';
    } catch (_) {
      return null;
    }
  }

  function currentChapterId() {
    return chapterIdFromHref(location.href);
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0;
  }

  function cleanText(value) {
    return String(value == null ? '' : value)
      .replace(/[\u00a0\u2007\u202f]/g, ' ')
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .replace(/[ \t\f\v\r]+/g, ' ')
      .trim();
  }

  function matchesAny(el, selectors) {
    if (!el || !selectors.length) return null;
    try {
      return el.closest(selectors.join(','));
    } catch (_) {
      return null;
    }
  }

  function isEditable(node) {
    if (!(node instanceof Element)) return false;
    if (node.isContentEditable) return true;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)) return true;
    return !!node.closest('[contenteditable]:not([contenteditable="false"])');
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // ---------------------------------------------------------------------------
  // Extraction
  // ---------------------------------------------------------------------------
  // Returns the outermost visible content containers, in document order.
  function getContentRoots() {
    for (const sel of SEL.contentSelectors) {
      let els = [];
      try {
        els = [...document.querySelectorAll(sel)].filter(isVisible);
      } catch (_) {
        continue;
      }
      if (!els.length) continue;
      // Keep only outermost containers so no text is read twice.
      return els.filter(node => !els.some(other => other !== node && other.contains(node)));
    }
    return findParagraphGroup();
  }

  // Fallback for sites whose class names are unknown: the chapter body is the
  // parent element that holds the most visible paragraph text.
  function findParagraphGroup() {
    const groups = new Map();
    for (const p of document.querySelectorAll('p')) {
      const parent = p.parentElement;
      if (!parent || !isVisible(p)) continue;
      const length = cleanText(p.innerText || p.textContent).length;
      if (length < 2) continue;
      const entry = groups.get(parent) || { count: 0, chars: 0 };
      entry.count += 1;
      entry.chars += length;
      groups.set(parent, entry);
    }
    let best = null;
    let bestChars = 0;
    for (const [node, info] of groups) {
      if (info.count >= 3 && info.chars > bestChars) {
        best = node;
        bestChars = info.chars;
      }
    }
    return best ? [best] : [];
  }

  const CHAPTER_HEADING = /(第\s*[0-9一二三四五六七八九十百千万零〇两]+\s*[章节回卷话集]|chapter\s*\d+)/i;

  // Looks for a chapter heading just before the content container, which is
  // where many novel sites place the title.
  function findTitleNearContent(roots) {
    if (!roots.length) return '';
    let node = roots[0];
    for (let level = 0; level < 4 && node; level++) {
      let sib = node.previousElementSibling;
      for (let i = 0; i < 6 && sib; i++) {
        const text = cleanText(sib.innerText || sib.textContent);
        if (text && text.length <= 60 && CHAPTER_HEADING.test(text)) return text;
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return '';
  }

  function getTitle() {
    for (const sel of SEL.titleSelectors) {
      let node = null;
      try {
        node = document.querySelector(sel);
      } catch (_) {
        continue;
      }
      if (node && isVisible(node)) {
        const text = cleanText(node.innerText || node.textContent);
        if (text) return text;
      }
    }
    const near = findTitleNearContent(getContentRoots());
    if (near) return near;
    const fromDoc = cleanText((document.title || '').split(/\s[-|–—_]\s?/)[0]);
    return fromDoc || 'Untitled chapter';
  }

  // An element is usable if it is visible and not inside an excluded element
  // that lives within the content root (ads, buttons, comments, etc.).
  function isUsable(node, root, excl) {
    if (!isVisible(node)) return false;
    const ex = excl ? node.closest(excl) : null;
    return !(ex && ex !== root && root.contains(ex));
  }

  function collectParagraphs(roots) {
    const excl = SEL.excludeSelectors.join(',');
    const out = [];
    const add = (raw) => {
      for (const line of String(raw || '').split(/\r?\n+/)) {
        const text = cleanText(line);
        if (text) out.push(text);
      }
    };

    for (const root of roots) {
      // Leaf paragraphs only, so nested <p> elements are not counted twice.
      const blocks = [...root.querySelectorAll('p')].filter(p => !p.querySelector('p'));
      if (blocks.length) {
        for (const p of blocks) {
          if (isUsable(p, root, excl)) add(p.innerText || p.textContent);
        }
      } else if (isUsable(root, root, excl)) {
        add(root.innerText || root.textContent);
      }
    }
    return out;
  }

  function extractChapter() {
    const id = currentChapterId();
    if (!id) return { ok: false, error: 'This is not a supported chapter page.' };

    const roots = getContentRoots();
    if (!roots.length) {
      return { ok: false, error: 'Unable to find chapter text. Try Retry Extraction. If it keeps failing, the page layout may have changed.' };
    }

    const paragraphs = collectParagraphs(roots);
    if (!paragraphs.length) {
      return { ok: false, error: 'The chapter container has no readable text yet.' };
    }

    const chars = paragraphs.reduce((total, p) => total + p.length, 0);
    if (chars < CONFIG.minChars) {
      return { ok: false, error: 'Extracted text looks incomplete. Please retry.' };
    }

    const title = getTitle();
    const signature = [
      title,
      paragraphs.length,
      chars,
      paragraphs[0].slice(0, 60),
      paragraphs[paragraphs.length - 1].slice(-60)
    ].join('|');

    return { ok: true, id, url: location.href, title, paragraphs, chars, signature };
  }

  function keyOf(data) {
    return data.id + '|' + data.signature;
  }

  function buildText(data, format) {
    const paragraphs = data.paragraphs;
    const title = settings.includeTitle && data.title ? data.title : '';
    if (format === 'plain') {
      return (title ? title + '\n' : '') + paragraphs.join('\n');
    }
    return (title ? title + '\n\n' : '') + paragraphs.join('\n\n');
  }

  function rememberChapter(data) {
    ss.set('wcc_chapter', data.id);
    ss.set('wcc_sig', data.signature);
  }

  function markCopied(key) {
    lastCopiedKey = key;
    ss.set('wcc_copied', key);
  }

  function successMessage(data) {
    return 'Chapter copied successfully!\n' + data.title + '\n' +
      data.chars.toLocaleString() + ' characters · ' + data.paragraphs.length + ' paragraphs';
  }

  // ---------------------------------------------------------------------------
  // Clipboard
  // Clipboard writes go through the background worker and an offscreen document,
  // which does not depend on page focus or a user gesture.
  // ---------------------------------------------------------------------------
  // All copies go through the offscreen document so the Rust/WASM engine
  // (or its JavaScript fallback) normalizes and validates the text first.
  // Returns { ok: true, characters, paragraphs, backend } or
  // { ok: false, invalid?: true, error }.
  async function writeClipboard(text) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'WCC_CLIPBOARD', text });
      if (res && res.ok) {
        return { ok: true, backend: res.backend, characters: res.characters, paragraphs: res.paragraphs };
      }
      if (res && res.invalid) return { ok: false, invalid: true, error: res.error };
      return { ok: false, error: (res && res.error) || 'Clipboard access was blocked.' };
    } catch (_) {
      return { ok: false, error: 'Extension connection was lost. Reload the page.' };
    }
  }

  // ---------------------------------------------------------------------------
  // Page UI (Shadow DOM so site CSS cannot interfere)
  // ---------------------------------------------------------------------------
  const UI_STYLE = `
    .stack { position: fixed; top: 16px; right: 16px; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
    .toast { font: 13px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; background: #1f2937; color: #f9fafb;
      padding: 10px 14px; border-radius: 10px; box-shadow: 0 6px 20px rgba(0,0,0,.3); max-width: 340px;
      white-space: pre-line; opacity: 0; transform: translateY(-6px); transition: opacity .2s, transform .2s; }
    .toast.show { opacity: 1; transform: none; }
    .toast.success { background: #14532d; }
    .toast.error { background: #7f1d1d; }
    .panel { position: fixed; bottom: 20px; right: 20px; width: 300px; font: 13px/1.45 system-ui, -apple-system, Segoe UI, sans-serif;
      background: #ffffff; color: #111827; border: 1px solid #d1d5db; border-radius: 12px; padding: 14px;
      box-shadow: 0 10px 30px rgba(0,0,0,.25); }
    .panel[hidden] { display: none; }
    .panel-title { font-weight: 600; margin-bottom: 6px; }
    .panel-body { color: #4b5563; margin-bottom: 10px; word-break: break-word; }
    .panel-row { display: flex; gap: 8px; }
    .btn { font: inherit; padding: 7px 12px; border-radius: 8px; border: 1px solid #d1d5db; background: #f9fafb; color: #111827; cursor: pointer; }
    .btn.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
  `;

  function getShadow() {
    let host = document.getElementById('wcc-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'wcc-host';
      host.setAttribute('style', 'all: initial;');
      (document.documentElement || document.body).appendChild(host);
    }
    if (!host.shadowRoot) {
      const root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = UI_STYLE;
      const stack = el('div', 'stack');
      const panel = el('div', 'panel');
      panel.hidden = true;
      root.append(style, stack, panel);
    }
    return host.shadowRoot;
  }

  function notify(message, kind = 'info') {
    if (!settings.notifications) return;
    const now = Date.now();
    if (message === lastToast.msg && now - lastToast.at < 2500) return;
    lastToast = { msg: message, at: now };

    const stack = getShadow().querySelector('.stack');
    while (stack.children.length >= 3) stack.firstElementChild.remove();

    const toast = el('div', 'toast ' + kind, message);
    stack.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 250);
    }, kind === 'error' ? 6000 : 3500);
  }

  // Shown only when the browser blocked automatic clipboard writing.
  // The Copy Now click is a real user gesture, so the copy can succeed here.
  function showCopyNowPanel() {
    if (!pending) return;
    const panel = getShadow().querySelector('.panel');
    panel.textContent = '';

    const title = el('div', 'panel-title', 'Clipboard access blocked');
    const body = el('div', 'panel-body', '"' + pending.data.title + '" is ready. Click Copy Now to copy it.');
    const row = el('div', 'panel-row');
    const copyBtn = el('button', 'btn primary', 'Copy Now');
    const dismissBtn = el('button', 'btn', 'Dismiss');

    copyBtn.addEventListener('click', async () => {
      if (!pending) return;
      const { data, text } = pending;
      const result = await writeClipboard(text);
      if (result.ok) {
        pending = null;
        panel.hidden = true;
        markCopied(keyOf(data));
        setState('copied', 'Chapter copied successfully');
        notify(successMessage(data), 'success');
      } else {
        notify('Copy failed. Select the chapter text manually or try again.', 'error');
      }
    });

    dismissBtn.addEventListener('click', () => {
      panel.hidden = true;
    });

    row.append(copyBtn, dismissBtn);
    panel.append(title, body, row);
    panel.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------
  function selectChapter() {
    const roots = getContentRoots();
    if (!roots.length) return { ok: false, error: 'Chapter text was not found on this page.' };
    try {
      const range = document.createRange();
      range.setStartBefore(roots[0]);
      range.setEndAfter(roots[roots.length - 1]);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return { ok: true };
    } catch (_) {
      return { ok: false, error: 'Selecting chapter text is not supported on this page.' };
    }
  }

  // ---------------------------------------------------------------------------
  // Manual copy
  // ---------------------------------------------------------------------------
  async function copyManual(format) {
    const data = extractChapter();
    if (!data.ok) {
      setState('failed', data.error);
      notify(data.error, 'error');
      return data;
    }

    const text = buildText(data, format);
    setState('copying', 'Copying text…');
    const result = await writeClipboard(text);
    rememberChapter(data);

    if (result.ok) {
      markCopied(keyOf(data));
      setState('copied', 'Chapter copied successfully');
      notify(successMessage(data), 'success');
      return { ok: true, title: data.title, chars: data.chars, paragraphs: data.paragraphs.length, backend: result.backend };
    }
    if (result.invalid) {
      setState('failed', result.error);
      notify(result.error, 'error');
      return { ok: false, error: result.error };
    }

    pending = { data, text };
    setState('clipboard-blocked', 'Clipboard permission required');
    notify('Clipboard access blocked. Click Copy Now on the page.', 'error');
    showCopyNowPanel();
    return { ok: false, error: 'Clipboard access was blocked. Use the Copy Now button on the page.' };
  }

  function retry() {
    const id = currentChapterId();
    if (!id) return { ok: false, error: 'This is not a supported WebNovel chapter page.' };
    statusCache = null;

    if (settings.autoCopy) {
      lastHandledId = id;
      onChapterChange(id, { prevSig: null });
      return { ok: true, message: 'Retrying extraction…' };
    }

    const result = extractChapter();
    if (result.ok) {
      return { ok: true, title: result.title, chars: result.chars, paragraphs: result.paragraphs.length, message: 'Chapter detected.' };
    }
    return result;
  }

  function getStatus() {
    const id = currentChapterId();
    const roots = id ? getContentRoots() : [];
    const supported = !!id && roots.length > 0;

    let info = null;
    if (supported) {
      if (!statusCache || statusCache.id !== id || !statusCache.data.ok) {
        statusCache = { id, data: extractChapter() };
      }
      info = statusCache.data;
    }

    return {
      ok: true,
      supported,
      title: info && info.ok ? info.title : '',
      chars: info && info.ok ? info.chars : 0,
      paragraphs: info && info.ok ? info.paragraphs.length : 0,
      error: supported ? (info && !info.ok ? info.error : '') : 'Open a WebNovel chapter page.',
      autoCopy: settings.autoCopy,
      ctrlA: settings.ctrlA,
      notifications: settings.notifications,
      format: settings.format,
      code: state.code,
      message: settings.autoCopy ? state.message : 'Auto-Copy is off'
    };
  }

  // ---------------------------------------------------------------------------
  // Waiting for a new chapter to finish loading
  // ---------------------------------------------------------------------------
  function waitForChapter(token, expectedId, prevSig) {
    return new Promise(resolve => {
      let done = false;
      let lastSig = null;
      let stableSince = 0;
      let debounce = null;
      let poll = null;
      let timeout = null;
      let observer = null;

      const finish = (result) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timeout);
        clearTimeout(debounce);
        if (observer) observer.disconnect();
        resolve(result);
      };

      const check = () => {
        if (done) return;
        if (token !== navToken) {
          finish({ ok: false, cancelled: true, error: 'Cancelled' });
          return;
        }
        // URL has moved to a different chapter; the newer navigation takes over.
        if (currentChapterId() !== expectedId) return;

        const result = extractChapter();
        if (!result.ok) {
          lastSig = null;
          return;
        }
        // Container still shows the previous chapter.
        if (prevSig && result.signature === prevSig) {
          lastSig = null;
          return;
        }
        // Content still changing: restart the stability timer.
        if (result.signature !== lastSig) {
          lastSig = result.signature;
          stableSince = Date.now();
          return;
        }
        // Stable long enough: the chapter is fully loaded.
        if (Date.now() - stableSince >= CONFIG.stableMs) {
          finish(result);
        }
      };

      observer = new MutationObserver(() => {
        clearTimeout(debounce);
        debounce = setTimeout(check, CONFIG.debounceMs);
      });
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
      });

      poll = setInterval(check, CONFIG.pollMs);
      timeout = setTimeout(() => {
        finish({ ok: false, error: 'Extraction timed out. Please retry.' });
      }, CONFIG.timeoutMs);

      check();
    });
  }

  // ---------------------------------------------------------------------------
  // Auto-Copy Next Chapter
  // ---------------------------------------------------------------------------
  async function onChapterChange(id, { prevSig = null } = {}) {
    if (!settings.autoCopy) return;

    const token = ++navToken;
    lastHandledId = id;
    statusCache = null;

    setState('waiting', 'Next chapter detected');
    notify('Next chapter detected.');
    setState('loading', 'Loading chapter…');

    const result = await waitForChapter(token, id, prevSig);
    if (token !== navToken) return;

    if (!result.ok) {
      setState('failed', result.error);
      notify(result.error, 'error');
      return;
    }

    setState('extracting', 'Extracting text…');
    const key = keyOf(result);

    if (key === lastCopiedKey) {
      rememberChapter(result);
      setState('copied', 'This chapter was already copied');
      return;
    }

    const text = buildText(result, settings.format);
    setState('copying', 'Copying text…');
    const written = await writeClipboard(text);
    rememberChapter(result);

    if (written.invalid) {
      setState('failed', written.error);
      notify(written.error, 'error');
      return;
    }

    if (written.ok) {
      markCopied(key);
      if (token === navToken) {
        setState('copied', 'Chapter copied successfully');
        notify(successMessage(result), 'success');
      }
      return;
    }

    if (token !== navToken) return;
    pending = { data: result, text };
    setState('clipboard-blocked', 'Clipboard permission required');
    notify('Clipboard access blocked. Click Copy Now.', 'error');
    showCopyNowPanel();
  }

  function onUrlChange() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    statusCache = null;

    const id = currentChapterId();
    if (!id) {
      navToken++;
      setState('idle', 'Not a chapter page');
      return;
    }
    if (id === lastHandledId) return;

    const prevSig = ss.get('wcc_sig');
    ss.set('wcc_chapter', id);
    onChapterChange(id, { prevSig });
  }

  function onDocumentClick(event) {
    if (!settings.autoCopy || !(event.target instanceof Element)) return;
    const nextButton = matchesAny(event.target, SEL.nextSelectors);
    const link = event.target.closest('a, button');
    const byText = link && CONFIG.nextLinkText.test(cleanText(link.textContent));
    if ((nextButton || byText) && currentChapterId()) {
      setState('waiting', 'Next chapter button clicked. Waiting for chapter…');
    }
  }

  // ---------------------------------------------------------------------------
  // Ctrl + A chapter-only selection (only when enabled and on a chapter page)
  // ---------------------------------------------------------------------------
  function onKeydown(event) {
    if (!settings.ctrlA) return;
    if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.isComposing) return;
    if (String(event.key).toLowerCase() !== 'a') return;
    if (isEditable(event.target) || isEditable(document.activeElement)) return;
    if (!currentChapterId() || !getContentRoots().length) return;

    event.preventDefault();
    const result = selectChapter();
    if (!result.ok) copyManual(settings.format);
  }

  function installWatchers() {
    window.addEventListener('popstate', onUrlChange);
    window.addEventListener('hashchange', onUrlChange);
    // Polling catches SPA navigations made by the page's own scripts, which
    // are invisible to an isolated content script that patches history.
    setInterval(onUrlChange, 500);
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('keydown', onKeydown, true);
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  async function loadSettings() {
    const stored = await chrome.storage.local.get({
      autoCopy: false,
      ctrlA: false,
      notifications: true,
      format: 'paragraph',
      selectorOverrides: {},
      customSites: [],
      includeTitle: true,
      extractionTimeoutMs: 25000
    });
    settings.includeTitle = stored.includeTitle !== false;
    CONFIG.timeoutMs = Math.min(120000, Math.max(5000, Number(stored.extractionTimeoutMs) || 25000));
    customSites = Array.isArray(stored.customSites) ? stored.customSites : [];
    settings.autoCopy = !!stored.autoCopy;
    settings.ctrlA = !!stored.ctrlA;
    settings.notifications = !!stored.notifications;
    settings.format = stored.format === 'plain' ? 'plain' : 'paragraph';
    SEL = buildSelectors(stored.selectorOverrides || {});
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.autoCopy) {
      settings.autoCopy = !!changes.autoCopy.newValue;
      if (settings.autoCopy) {
        // Only chapters loaded after this point are auto-copied.
        lastHandledId = currentChapterId();
        setState(currentChapterId() ? 'waiting' : 'idle',
          currentChapterId() ? 'Waiting for next chapter' : 'Not a chapter page');
      } else {
        navToken++;
        setState('off', 'Auto-Copy is off');
      }
    }
    if (changes.ctrlA) settings.ctrlA = !!changes.ctrlA.newValue;
    if (changes.notifications) settings.notifications = !!changes.notifications.newValue;
    if (changes.format) settings.format = changes.format.newValue === 'plain' ? 'plain' : 'paragraph';
    if (changes.includeTitle) settings.includeTitle = changes.includeTitle.newValue !== false;
    if (changes.extractionTimeoutMs) {
      CONFIG.timeoutMs = Math.min(120000, Math.max(5000, Number(changes.extractionTimeoutMs.newValue) || 25000));
    }
    if (changes.selectorOverrides) SEL = buildSelectors(changes.selectorOverrides.newValue || {});
    if (changes.customSites) customSites = Array.isArray(changes.customSites.newValue) ? changes.customSites.newValue : [];
  });

  // ---------------------------------------------------------------------------
  // Messaging (popup and background only; sender must be this extension)
  // ---------------------------------------------------------------------------
  function handleCommand(command) {
    if (command === 'copy') {
      copyManual(settings.format).then(result => {
        if (!result.ok && result.error) notify(result.error, 'error');
      });
    } else if (command === 'retry') {
      const result = retry();
      if (!result.ok) notify(result.error, 'error');
      else if (result.message) notify(result.message);
    } else if (command === 'select') {
      const result = selectChapter();
      if (!result.ok) notify(result.error, 'error');
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return false;

    switch (message.type) {
      case 'WCC_STATUS':
        sendResponse(getStatus());
        return false;
      case 'WCC_EXTRACT':
        sendResponse(extractChapter());
        return false;
      case 'WCC_COPY':
        copyManual(message.format === 'plain' ? 'plain' : 'paragraph')
          .then(sendResponse, err => sendResponse({ ok: false, error: String(err && err.message || err) }));
        return true;
      case 'WCC_SELECT':
        sendResponse(selectChapter());
        return false;
      case 'WCC_RETRY':
        sendResponse(retry());
        return false;
      case 'WCC_COMMAND':
        handleCommand(message.command);
        return false;
      default:
        return false;
    }
  });

  // ---------------------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------------------
  async function init() {
    await loadSettings();
    lastCopiedKey = ss.get('wcc_copied');
    installWatchers();

    const id = currentChapterId();
    if (!id) {
      setState('idle', 'Not a chapter page');
      return;
    }

    // Full-page navigation: compare with the chapter this tab showed before.
    const prevChapter = ss.get('wcc_chapter');
    const prevSig = ss.get('wcc_sig');
    ss.set('wcc_chapter', id);
    lastHandledId = id;

    if (settings.autoCopy && prevChapter && prevChapter !== id) {
      onChapterChange(id, { prevSig });
    } else if (settings.autoCopy) {
      setState('waiting', 'Waiting for next chapter');
    } else {
      setState('off', 'Auto-Copy is off');
    }
  }

  init().catch(err => console.error('[WebNovel Chapter Copier]', err));
})();
