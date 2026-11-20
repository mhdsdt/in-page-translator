import assert from 'node:assert/strict';
import test from 'node:test';
import {
  downloadProgressRatio, formatDownloadBytes, formatDownloadFailure, formatDownloadLabel,
} from '../../src/shared/format';

test('download formatting handles single-pack, multi-pack pivot, and saving states', () => {
  const single = { pack: 'de:en', received: 5 * 2 ** 20, total: 10 * 2 ** 20, saving: false, step: 1, steps: 1 };
  assert.equal(downloadProgressRatio(single), 0.5);
  assert.equal(formatDownloadLabel(single), 'Downloading German → English');
  assert.equal(formatDownloadLabel(single, true), 'Downloading German → English…');
  assert.equal(formatDownloadBytes(single), '5 MiB of 10 MiB · 50%');

  const pivot = { pack: 'en:fr', received: 2 * 2 ** 20, total: 8 * 2 ** 20, saving: false, step: 2, steps: 2 };
  assert.equal(formatDownloadLabel(pivot, true), 'Downloading English → French (2 of 2)…');
  assert.equal(formatDownloadBytes(pivot), '2 MiB of 8 MiB · 25%');

  const saving = { ...pivot, saving: true };
  assert.equal(downloadProgressRatio(saving), 1);
  assert.equal(formatDownloadLabel(saving), 'Saving English → French (2 of 2)…');
});

test('formatDownloadFailure produces actionable messages for each failure reason', () => {
  assert.match(formatDownloadFailure({ pack: 'de:en', error: 'storage-failed' }), /Couldn’t save German → English/);
  assert.match(formatDownloadFailure({ pack: 'de:en', error: 'integrity-failed' }), /did not pass verification/);
  assert.match(formatDownloadFailure({ pack: 'de:en', error: 'download-failed' }), /Check the connection/);
});
