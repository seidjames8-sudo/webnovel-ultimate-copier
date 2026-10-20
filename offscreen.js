/*
 * Offscreen document: runs text processing and clipboard writes.
 *
 * Why offscreen: service workers cannot touch the clipboard, and content
 * scripts may not have focus during Auto-Copy. This document is an extension
 * page, so it can use WASM (allowed by the extension CSP) and write the
 * clipboard.
 */
function copyWithTextarea(text) {
  const sink = document.getElementById('clipboard-sink');
  sink.value = text;
  sink.focus();
  sink.select();
  sink.setSelectionRange(0, sink.value.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (_) {
    ok = false;
  }
  sink.value = '';
  return ok;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || message.target !== 'offscreen') return false;

  if (message.type === 'WCC_ENGINE_INFO') {
    WccEngine.ready.then(backend => {
      sendResponse({ backend, error: WccEngine.loadError });
    });
    return true;
  }

  if (message.type !== 'WCC_WRITE') return false;

  WccEngine.ready
    .then(backend => {
      const text = WccEngine.normalize(message.text);
      if (!WccEngine.validate(text)) {
        sendResponse({ ok: false, invalid: true, backend, error: 'Chapter text is empty or too short to copy.' });
        return;
      }
      const stats = WccEngine.stats(text);
      const ok = copyWithTextarea(text);
      if (!ok) {
        sendResponse({ ok: false, backend, error: 'The browser blocked the clipboard write.' });
        return;
      }
      sendResponse({
        ok: true,
        backend,
        characters: stats.characters,
        paragraphs: stats.paragraphs
      });
    })
    .catch(err => sendResponse({ ok: false, error: String((err && err.message) || err) }));

  return true;
});
