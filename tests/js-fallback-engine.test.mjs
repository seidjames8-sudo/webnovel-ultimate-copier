// Mirrors rust-engine/src/lib.rs unit tests. Run with: npm run test:js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const engine = require('../js-fallback-engine.js');
const { normalize_chapter_text: normalize, count_characters, count_paragraphs,
        validate_chapter_text: validate, get_text_statistics: statistics } = engine;

test('empty string stays empty', () => {
  assert.equal(normalize(''), '');
  assert.equal(count_characters(''), 0);
  assert.equal(count_paragraphs(''), 0);
  assert.equal(validate(''), false);
});

test('whitespace only is empty', () => {
  assert.equal(normalize('   \n\t \n'), '');
  assert.equal(count_paragraphs('   \n\t \n'), 0);
  assert.equal(validate('   \n\t \n'), false);
});

test('multiple paragraphs keep their blank line', () => {
  const input = '第一段。\n\n第二段！';
  assert.equal(normalize(input), input);
  assert.equal(count_paragraphs(input), 2);
});

test('CRLF and CR become LF', () => {
  assert.equal(normalize('A\r\n\r\nB'), 'A\n\nB');
  assert.equal(normalize('A\rB'), 'A\nB');
});

test('runs of blank lines collapse to one', () => {
  assert.equal(normalize('A\n\n\n\nB'), 'A\n\nB');
});

test('leading and trailing blank lines are removed', () => {
  assert.equal(normalize('\n\n  Hello  \n\n'), 'Hello');
});

test('non-breaking spaces collapse to one space', () => {
  assert.equal(normalize('a\u00A0\u00A0b'), 'a b');
});

test('ideographic indent is removed at line start', () => {
  assert.equal(normalize('\u3000\u3000他说：“你好。”'), '他说：“你好。”');
});

test('ideographic space inside a line is preserved', () => {
  assert.equal(normalize('内 部\u3000空格'), '内 部\u3000空格');
});

test('zero-width space and BOM are removed', () => {
  assert.equal(normalize('zero\u200Bwidth\uFEFF'), 'zerowidth');
});

test('zero-width joiner is preserved for emoji', () => {
  const emoji = '👨\u200D👩';
  assert.equal(normalize(emoji), emoji);
});

test('punctuation and dialogue are unchanged', () => {
  const input = '“Hi,” she said—“wait…”';
  assert.equal(normalize(input), input);
});

test('repeated paragraphs are never removed', () => {
  const input = 'Yes.\n\nYes.\n\nYes.';
  assert.equal(normalize(input), input);
  assert.equal(count_paragraphs(input), 3);
});

test('character counts include spaces and count code points', () => {
  assert.equal(count_characters('你好 世界'), 5);
  assert.equal(count_characters('👨\u200D👩'), 3);
});

test('paragraph counts ignore blank lines', () => {
  assert.equal(count_paragraphs('第一段\n\n第二段\n第三段'), 3);
});

test('statistics are computed on normalized text', () => {
  const stats = statistics('a b\n\nc');
  assert.equal(stats.characters, 6);
  assert.equal(stats.paragraphs, 2);
  assert.equal(stats.non_whitespace, 3);
  assert.equal(stats.normalized, 'a b\n\nc');
});

test('validation requires minimum visible characters', () => {
  assert.equal(validate('a'.repeat(99)), false);
  assert.equal(validate('a'.repeat(100)), true);
  assert.equal(validate('汉'.repeat(100)), true);
});

test('spaces do not count toward validation', () => {
  assert.equal(validate('a '.repeat(50)), false);
});

test('very long text is processed completely', () => {
  const input = '段落测试。\n\n'.repeat(20000);
  const stats = statistics(input);
  assert.equal(stats.paragraphs, 20000);
  assert.equal(stats.characters, 20000 * 5 + 19999 * 2);
  assert.ok(stats.normalized.endsWith('段落测试。'));
  assert.equal(validate(input), true);
});

test('null and undefined input do not throw', () => {
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
});
