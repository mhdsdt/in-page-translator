import assert from 'node:assert/strict';
import test from 'node:test';
import { packBatches, takeBucketedBatch, takePrefixBatch } from '../../src/shared/batch';

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

test('takeBucketedBatch separates lengths, honors preferShort/preferLong, prevents starvation, and stops at groups', () => {
  const mk = (pair: string, len: number, tag: string) => ({ pair, text: 'x'.repeat(len), tag });
  const queue = [
    mk('de:en', 160, 'L1'),
    mk('de:en', 12, 'S1'),
    mk('de:en', 80, 'M1'),
    mk('de:en', 18, 'S2'),
    mk('de:en', 200, 'L2'),
    mk('fr:en', 10, 'OTHER'),
  ];

  // preferShort pulls short items first without crossing into fr:en.
  const first = takeBucketedBatch(queue, j => j.pair === 'de:en', j => j.text.length, { preferShort: true });
  assert.deepEqual(first.map(j => j.tag), ['S1', 'S2']);

  // preferLong pulls long items descending without mixing medium M1.
  const second = takeBucketedBatch(queue, j => j.pair === 'de:en', j => j.text.length, { preferLong: true });
  assert.deepEqual(second.map(j => j.tag), ['L2', 'L1']);

  // Remaining de:en item M1 drains cleanly without picking fr:en OTHER.
  const third = takeBucketedBatch(queue, j => j.pair === 'de:en', j => j.text.length);
  assert.deepEqual(third.map(j => j.tag), ['M1']);
  assert.deepEqual(queue.map(j => j.tag), ['OTHER']);

  // Fallback (no preferShort/preferLong) drains oldest item's bucket (L0 included -> zero starvation).
  const antiStarve = [mk('de:en', 150, 'OLD_LONG'), mk('de:en', 15, 'NEW_SHORT'), mk('de:en', 155, 'LONG2')];
  const drained = takeBucketedBatch(antiStarve, () => true, j => j.text.length);
  assert.deepEqual(drained.map(j => j.tag), ['LONG2', 'OLD_LONG']);
  assert.deepEqual(antiStarve.map(j => j.tag), ['NEW_SHORT']);

  // Oversized single item still makes progress as a batch of 1.
  const oversized = [mk('de:en', 1_500, 'HUGE'), mk('de:en', 1_400, 'HUGE2')];
  assert.deepEqual(takeBucketedBatch(oversized, () => true, j => j.text.length).map(j => j.tag), ['HUGE']);
  assert.deepEqual(oversized.map(j => j.tag), ['HUGE2']);
});

test('property: takeBucketedBatch losslessly drains randomized multi-pair queues without cross-group leakage', () => {
  let state = 0x1234_5678;
  const rand = (n: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % n;
  };
  const pairs = ['de:en', 'fr:en', 'es:en'] as const;

  for (let trial = 0; trial < 100; trial++) {
    const count = 1 + rand(60);
    const original = Array.from({ length: count }, (_, id) => ({
      id,
      pair: pairs[rand(pairs.length)]!,
      len: 1 + rand(500),
    }));
    const queue = original.slice();
    const out: typeof original = [];
    while (queue.length) {
      const pair = queue[0]!.pair;
      const batch = takeBucketedBatch(queue, j => j.pair === pair, j => j.len, {
        preferShort: rand(3) === 0,
        preferLong: rand(3) === 0,
      });
      assert.ok(batch.length >= 1);
      assert.ok(batch.every(j => j.pair === pair));
      out.push(...batch);
    }
    assert.deepEqual(out.map(j => j.id).sort((a, b) => a - b), original.map(j => j.id));
  }
});
