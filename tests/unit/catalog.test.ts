import assert from 'node:assert/strict';
import test from 'node:test';
import { catalog, formatSize, inputs, outputs, packBytes, packKey, routeFor } from '../../src/shared/catalog';

test('routeFor returns direct routes, English pivot routes, and empty for same/unsupported pairs', () => {
  assert.deepEqual(routeFor('en', 'en'), []);
  assert.deepEqual(routeFor('de', 'de'), []);
  assert.deepEqual(routeFor('xx', 'en'), []);

  const direct = routeFor('de', 'en');
  assert.equal(direct.length, 1);
  assert.equal(direct[0]?.id, 'de:en');

  const pivot = routeFor('de', 'fr');
  assert.deepEqual(pivot.map(pack => pack.id), ['de:en', 'en:fr']);
});

test('catalog inputs/outputs, packKey, packBytes, and formatSize are consistent', () => {
  assert.ok(inputs.includes('en'));
  assert.ok(outputs.includes('en'));
  assert.ok(catalog.size > 50);

  const pack = catalog.get('de:en')!;
  assert.equal(packKey(pack), pack.id + '@' + pack.revision);
  assert.ok(packBytes(pack, 'size') > 0);
  assert.ok(packBytes(pack, 'bytes') >= packBytes(pack, 'size'));
  assert.equal(formatSize(2 ** 20), '1 MiB');
  assert.equal(formatSize(1.5 * 2 ** 20), '1.5 MiB');
});

test('every catalog route pair resolves cleanly without duplicate or malformed packs', () => {
  for (const pack of catalog.values()) {
    assert.equal(pack.id, `${pack.from}:${pack.to}`);
    assert.match(pack.revision, /^[0-9a-f]{20}$/u);
    assert.ok(pack.assets.length >= 3);
    assert.deepEqual(routeFor(pack.from, pack.to).map(p => p.id), [pack.id]);
  }
});
