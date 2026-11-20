import assert from 'node:assert/strict';
import test from 'node:test';
import { packBatches, takePrefixBatch } from '../../src/shared/batch';

test('packBatches respects maxItems, maxChars, order, and handles oversized single items', () => {
  assert.deepEqual(packBatches([], (s: string) => s.length, { maxItems: 4, maxChars: 10 }), []);

  const items = ['aaa', 'bbb', 'ccc', 'dddddddddddd', 'e', 'f', 'g'];
  const batches = packBatches(items, s => s.length, { maxItems: 2, maxChars: 6 });
  assert.deepEqual(batches, [
    ['aaa', 'bbb'],
    ['ccc'],
    ['dddddddddddd'],
    ['e', 'f'],
    ['g'],
  ]);
  assert.deepEqual(batches.flat(), items);
});

test('takePrefixBatch stops at group boundaries, item cap, and char cap', () => {
  const jobs = [
    { pair: 'fr:en', text: '1234' },
    { pair: 'fr:en', text: '5678' },
    { pair: 'fr:en', text: '90' },
    { pair: 'de:en', text: 'abcd' },
  ];

  assert.deepEqual(
    takePrefixBatch(jobs, j => j.pair === 'fr:en', j => j.text.length, { maxItems: 10, maxChars: 8 }),
    [jobs[0], jobs[1]],
  );

  assert.deepEqual(
    takePrefixBatch(jobs, j => j.pair === 'fr:en', j => j.text.length, { maxItems: 10, maxChars: 100 }),
    [jobs[0], jobs[1], jobs[2]],
  );

  // Oversized leading item still makes progress as a batch of 1.
  assert.deepEqual(
    takePrefixBatch(jobs, j => j.pair === 'fr:en', j => j.text.length, { maxItems: 10, maxChars: 2 }),
    [jobs[0]],
  );
});
