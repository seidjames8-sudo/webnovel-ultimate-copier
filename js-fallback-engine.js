/*
 * JavaScript mirror of rust-engine/src/lib.rs.
 *
 * Used when the WASM module is not built or fails to load. It implements the
 * same rules and exposes the same function names as the WASM exports, so the
 * rest of the extension does not need to know which backend is active.
 * tests/js-fallback-engine.test.mjs checks it against the same cases as the
 * Rust unit tests.
 */
(function (global) {
  'use strict';

  const MIN_CHAPTER_CHARS = 100;

  // Same sets as the Rust code.
  const EDGE_SPACE = new Set([' ', '\t', '\u00A0', '\u3000', '\u2007', '\u202F']);
  const COLLAPSIBLE = new Set([' ', '\t', '\u00A0', '\u2007', '\u202F']);
  const INVISIBLE = new Set(['\u200B', '\uFEFF']);

  function normalizeLine(line) {
    // Iterate by code point so it matches Rust's char handling.
    const chars = [...line];
    let start = 0;
    let end = chars.length;
    while (start < end && EDGE_SPACE.has(chars[start])) start++;
    while (end > start && EDGE_SPACE.has(chars[end - 1])) end--;

    let out = '';
    let inRun = false;
    for (let i = start; i < end; i++) {
      const c = chars[i];
      if (COLLAPSIBLE.has(c)) {
        if (!inRun) {
          out += ' ';
          inRun = true;
        }
      } else {
        out += c;
        inRun = false;
      }
    }
    return out;
  }

  function normalize(input) {
    const unified = String(input == null ? '' : input).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = [];
    let pendingBlank = false;

    for (const raw of unified.split('\n')) {
      const visible = [...raw].filter(c => !INVISIBLE.has(c)).join('');
      const line = normalizeLine(visible);
      if (line === '') {
        if (blocks.length > 0) pendingBlank = true;
      } else {
        if (pendingBlank) {
          blocks.push('');
          pendingBlank = false;
        }
        blocks.push(line);
      }
    }
    return blocks.join('\n');
  }

  function countCodePoints(text) {
    let n = 0;
    for (const _ of text) n++;
    return n;
  }

  function count_characters(input) {
    return countCodePoints(normalize(input));
  }

  function count_paragraphs(input) {
    return normalize(input).split('\n').filter(line => line !== '').length;
  }

  function statistics(input) {
    const normalized = normalize(input);
    const nonWhitespace = [...normalized].filter(c => !/\s/u.test(c)).length;
    return {
      characters: countCodePoints(normalized),
      paragraphs: normalized.split('\n').filter(line => line !== '').length,
      non_whitespace: nonWhitespace,
      normalized
    };
  }

  function validate_chapter_text(input) {
    return statistics(input).non_whitespace >= MIN_CHAPTER_CHARS;
  }

  const api = {
    MIN_CHAPTER_CHARS,
    normalize_chapter_text: normalize,
    count_characters,
    count_paragraphs,
    validate_chapter_text,
    get_text_statistics: statistics
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.WccJsEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
