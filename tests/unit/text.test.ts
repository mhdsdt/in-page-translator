import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_TRANSLATION_CHARS } from '../../src/shared/offline';
import { splitText } from '../../src/shared/text';

test('splitText returns empty for empty input and single chunk for short input', () => {
  assert.deepEqual(Array.from(splitText('')), []);
  assert.deepEqual(Array.from(splitText('Bonjour tout le monde')), ['Bonjour tout le monde']);
});

test('splitText prefers sentence boundaries for Latin and CJK text', () => {
  const sentences = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} has several words in it.`).join(' ');
  const chunks = Array.from(splitText(sentences, 300, 200));
  assert.ok(chunks.length >= 2);
  assert.equal(chunks.join(''), sentences);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 300);
  }
  assert.ok(chunks[0]!.endsWith('.'));

  const cjk = 'これは日本語の長い文章です。'.repeat(40);
  const cjkChunks = Array.from(splitText(cjk, 200, 120));
  assert.equal(cjkChunks.join(''), cjk);
  for (const chunk of cjkChunks) {
    assert.ok(chunk.length <= 200);
  }
  assert.ok(cjkChunks[0]!.endsWith('。'));
});

test('splitText never splits UTF-16 surrogate pairs on unbroken emoji strings', () => {
  // Each emoji is 2 UTF-16 code units; odd maxChars would slice mid-pair without surrogate protection.
  const emojis = '😀'.repeat(100);
  const chunks = Array.from(splitText(emojis, 51, 35));
  assert.equal(chunks.join(''), emojis);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 51);
    assert.equal(chunk.length % 2, 0, 'surrogate pair was split');
    assert.ok(!/[\ud800-\udfff](?![\udc00-\udfff])|^[\udc00-\udfff]/u.test(chunk));
  }
});

test('property: splitText is lossless and respects maxChars across 200 randomized inputs', () => {
  let seed = 0x12345678;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const alphabet = ['a', 'b', ' ', '\n', '.', '!', '?', '。', '！', '漢', 'é', '🚀', '🌍', 'x'];

  for (let trial = 0; trial < 200; trial++) {
    const length = 1 + Math.floor(next() * 3_500);
    let input = '';
    while (input.length < length) {
      input += alphabet[Math.floor(next() * alphabet.length)]!;
    }
    const chunks = Array.from(splitText(input));
    assert.equal(chunks.join(''), input, `lossy split on trial ${trial}`);
    for (const chunk of chunks) {
      assert.ok(chunk.length > 0 && chunk.length <= MAX_TRANSLATION_CHARS, `invalid chunk size ${chunk.length}`);
      // Ensure no dangling lone surrogates were created at chunk boundaries.
      const first = chunk.charCodeAt(0);
      const last = chunk.charCodeAt(chunk.length - 1);
      assert.ok(!(first >= 0xdc00 && first <= 0xdfff), 'leading low surrogate');
      assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'trailing high surrogate');
    }
  }
});
