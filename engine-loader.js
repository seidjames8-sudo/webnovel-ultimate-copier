/*
 * Text engine loader.
 *
 * Tries to load the Rust/WASM engine from wasm/text_engine.js. It runs a
 * self-test before trusting the module. If anything fails, it keeps the
 * JavaScript fallback engine. A WASM failure never stops the extension.
 *
 * Exposes globalThis.WccEngine:
 *   backend      'wasm' or 'js'
 *   loadError    message when WASM could not be used, otherwise null
 *   ready        Promise that resolves to the active backend name
 *   normalize(text), validate(text), stats(text)
 */
(function (global) {
  'use strict';

  const engine = {
    backend: 'js',
    loadError: null,
    impl: global.WccJsEngine,
    ready: null,
    normalize(text) {
      return this.impl.normalize_chapter_text(text == null ? '' : String(text));
    },
    validate(text) {
      return this.impl.validate_chapter_text(text == null ? '' : String(text));
    },
    stats(text) {
      return this.impl.get_text_statistics(text == null ? '' : String(text));
    }
  };

  engine.ready = (async () => {
    if (!global.WccJsEngine) {
      engine.loadError = 'JavaScript fallback engine is missing.';
      return engine.backend;
    }
    try {
      const moduleUrl = chrome.runtime.getURL('wasm/text_engine.js');
      const wasmUrl = chrome.runtime.getURL('wasm/text_engine_bg.wasm');
      const wasm = await import(moduleUrl);

      const response = await fetch(wasmUrl);
      if (!response.ok) {
        throw new Error('Could not read wasm/text_engine_bg.wasm (HTTP ' + response.status + '). Run npm run build:wasm.');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      // WebAssembly files start with the magic bytes 00 61 73 6d ("\0asm").
      if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
        throw new Error('wasm/text_engine_bg.wasm is not a valid WebAssembly file.');
      }

      // Compile here, then hand the ready module to wasm-bindgen.
      const compiled = new WebAssembly.Module(bytes);
      wasm.initSync(compiled);

      // Self-test: the binding must give the expected answer before we use it.
      const probe = wasm.get_text_statistics('段落。');
      if (!probe || probe.characters !== 3 || wasm.normalize_chapter_text('a\r\n\r\nb') !== 'a\n\nb') {
        throw new Error('WASM self-test returned unexpected results.');
      }
      engine.impl = wasm;
      engine.backend = 'wasm';
    } catch (err) {
      engine.loadError = String((err && err.message) || err);
      engine.impl = global.WccJsEngine;
      engine.backend = 'js';
      console.warn('[WebNovel Ultimate Copier] WASM engine unavailable, using JavaScript fallback:', engine.loadError);
    }
    return engine.backend;
  })();

  global.WccEngine = engine;
})(globalThis);
