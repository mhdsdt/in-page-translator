import assert from 'node:assert/strict';
import test from 'node:test';
import { badgeForDownload, badgeForPage } from '../../src/shared/badge';

test('badgeForPage derives concise tab-scoped badge state for every translation phase', () => {
  assert.deepEqual(badgeForPage({ phase: 'original', updated: 0, failed: 0 }), { text: '', color: '' });
  assert.deepEqual(badgeForPage({ phase: 'restoring', updated: 0, failed: 0 }), { text: '', color: '' });
  assert.deepEqual(badgeForPage({ phase: 'preparing', updated: 0, failed: 0 }), { text: '…', color: '#355245' });
  assert.deepEqual(badgeForPage({ phase: 'translating', updated: 4, failed: 0 }), { text: '…', color: '#355245' });

  assert.deepEqual(
    badgeForPage({ phase: 'translated', source: 'de', target: 'en', updated: 5, failed: 0 }),
    { text: 'EN', color: '#236544' },
  );
  assert.deepEqual(
    badgeForPage({ phase: 'translated', source: 'en', target: 'zh-Hans', updated: 5, failed: 0 }),
    { text: 'ZH', color: '#236544' },
  );
  assert.deepEqual(
    badgeForPage({ phase: 'translated', source: 'de', target: 'en', updated: 4, failed: 1 }),
    { text: '!', color: '#805015' },
  );
  assert.deepEqual(
    badgeForPage({ phase: 'translated', source: 'de', target: 'en', updated: 0, failed: 0, error: 'no-text' }),
    { text: '!', color: '#805015' },
  );
  assert.deepEqual(
    badgeForPage({ phase: 'error', updated: 0, failed: 0, error: 'engine-unavailable' }),
    { text: '!', color: '#a13629' },
  );
});

test('badgeForDownload formats percentage progress and saving indicator', () => {
  assert.deepEqual(
    badgeForDownload({ pack: 'de:en', received: 4_500, total: 10_000, saving: false, step: 1, steps: 1 }),
    { text: '45%', color: '#355245' },
  );
  assert.deepEqual(
    badgeForDownload({ pack: 'de:en', received: 10_000, total: 10_000, saving: false, step: 1, steps: 1 }),
    { text: '99%', color: '#355245' },
  );
  assert.deepEqual(
    badgeForDownload({ pack: 'de:en', received: 10_000, total: 10_000, saving: true, step: 1, steps: 1 }),
    { text: '…', color: '#355245' },
  );
});
