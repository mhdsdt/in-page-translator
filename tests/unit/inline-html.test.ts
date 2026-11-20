import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeHtmlEntities, escapeHtml, parseInlineHtml, validateInlineTranslation,
} from '../../src/shared/inline-html';

test('escapeHtml and decodeHtmlEntities round-trip safely without double-decoding', () => {
  const raw = '5 < 10 & 10 > 5 "quoted"';
  const escaped = escapeHtml(raw);
  assert.equal(escaped, '5 &lt; 10 &amp; 10 &gt; 5 "quoted"');
  assert.equal(decodeHtmlEntities(escaped), raw);
  assert.equal(decodeHtmlEntities('A&#x20;B &#65; &nbsp; &amp;lt;'), 'A B A \u00a0 &lt;');
});

test('parseInlineHtml parses nested, reordered, and opaque slots while stripping unknown tags', () => {
  const validIds = new Set([0, 1, 2]);
  const parsed = parseInlineHtml(
    'Read <span id="0">the <em><span id="1">official</span></em> guide</span> and run <code id="2" translate="no">npm test</code>.<script>alert(1)</script>',
    validIds,
  );
  assert.deepEqual(parsed.seenIds, new Set([0, 1, 2]));
  assert.deepEqual(parsed.duplicateIds, new Set());
  assert.deepEqual(parsed.nodes, [
    { type: 'text', value: 'Read ' },
    {
      type: 'slot',
      id: 0,
      children: [
        { type: 'text', value: 'the ' },
        { type: 'slot', id: 1, children: [{ type: 'text', value: 'official' }] },
        { type: 'text', value: ' guide' },
      ],
    },
    { type: 'text', value: ' and run ' },
    { type: 'slot', id: 2, children: [{ type: 'text', value: 'npm test' }] },
    { type: 'text', value: '.alert(1)' },
  ]);
  assert.equal(validateInlineTranslation(parsed, validIds, new Set([2])), true);
});

test('validateInlineTranslation rejects dropped tags and duplicated opaque tags while permitting split non-opaque tags', () => {
  const expected = new Set([0, 1]);
  const opaque = new Set([1]);

  const dropped = parseInlineHtml('Read the guide <code id="1">npm test</code>', expected);
  assert.equal(validateInlineTranslation(dropped, expected, opaque), false);

  const dupOpaque = parseInlineHtml('<span id="0">A</span> <code id="1">x</code> <code id="1">x</code>', expected);
  assert.equal(validateInlineTranslation(dupOpaque, expected, opaque), false);

  const splitNonOpaque = parseInlineHtml('<span id="0">A</span> and <span id="0">B</span> <code id="1">x</code>', expected);
  assert.equal(validateInlineTranslation(splitNonOpaque, expected, opaque), true);
});

test('property: parseInlineHtml handles 200 arbitrary malformed or reordered HTML payloads without throwing', () => {
  let seed = 0x51a9d00d;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const tokens = [
    'word ', '<b>', '</b>', '<span id="0">', '<span id=\'1\'>', '</span>',
    '<code id="2" translate="no">', '</code>', '<span id="99">', '<img src=x>', '&amp;', '<', '>',
  ];
  const valid = new Set([0, 1, 2]);

  for (let trial = 0; trial < 200; trial++) {
    let payload = '';
    const count = 1 + Math.floor(next() * 25);
    for (let i = 0; i < count; i++) {
      payload += tokens[Math.floor(next() * tokens.length)]!;
    }
    const parsed = parseInlineHtml(payload, valid);
    assert.ok(Array.isArray(parsed.nodes));
    for (const id of parsed.seenIds) assert.ok(valid.has(id));
  }
});
