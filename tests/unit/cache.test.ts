import assert from 'node:assert/strict';
import test from 'node:test';
import { LruCache } from '../../src/shared/cache';

test('LruCache supports get/peek/set, LRU eviction, delete, clear, and zero capacity', () => {
  const cache = new LruCache<string, number>(2);
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.size, 2);

  assert.equal(cache.peek('a'), 1);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);

  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);

  assert.equal(cache.delete('a'), true);
  assert.equal(cache.delete('missing'), false);
  assert.equal(cache.size, 1);

  cache.clear();
  assert.equal(cache.size, 0);

  const disabled = new LruCache<string, number>(0);
  disabled.set('x', 1);
  assert.equal(disabled.size, 0);
  assert.equal(disabled.get('x'), undefined);
});
