import assert from 'node:assert/strict';
import test from 'node:test';
import { derivePacksView } from '../../src/packs/view';

test('derivePacksView handles loading, read errors, invalid pairs, and empty disk usage', () => {
  const loading = derivePacksView({
    from: 'de',
    to: 'en',
    state: undefined,
    pending: false,
    readFailed: false,
    canReturnToPage: false,
  });
  assert.equal(loading.installDisabled, true);
  assert.equal(loading.installHidden, false);
  assert.equal(loading.requirementsText, 'Checking installed packs…');
  assert.equal(loading.usageText, 'Checking storage…');
  assert.equal(loading.installedEmpty, false);
  assert.equal(loading.noticeText, '');

  const failed = derivePacksView({
    from: 'de',
    to: 'en',
    state: undefined,
    pending: false,
    readFailed: true,
    canReturnToPage: true,
  });
  assert.equal(failed.requirementsText, 'Pack status unavailable.');
  assert.equal(failed.usageText, 'Storage status unavailable');
  assert.equal(failed.noticeError, true);
  assert.match(failed.noticeText, /Couldn’t read installed language packs/);

  const same = derivePacksView({
    from: 'en',
    to: 'en',
    state: { installed: [] },
    pending: false,
    readFailed: false,
    canReturnToPage: false,
  });
  assert.equal(same.requirementsText, 'Choose two different languages.');
  assert.equal(same.usageText, '0 MiB on disk');
  assert.equal(same.installedEmpty, true);
});

test('derivePacksView handles pivot routes, ready state, active transfers, notices, and installed sorting', () => {
  const partialPivot = derivePacksView({
    from: 'de',
    to: 'fr',
    state: { installed: ['fr:en', 'de:en'] },
    pending: false,
    readFailed: false,
    canReturnToPage: false,
  });
  assert.equal(partialPivot.routeSummary, 'This pair translates through English.');
  assert.deepEqual(partialPivot.route.map(step => [step.id, step.installed]), [
    ['de:en', true],
    ['en:fr', false],
  ]);
  assert.equal(partialPivot.route[0]!.sizeText, 'Installed');
  assert.match(partialPivot.route[1]!.sizeText, /MiB/);
  assert.match(partialPivot.requirementsText, /^1 pack to download · /);
  assert.equal(partialPivot.installDisabled, false);
  assert.equal(partialPivot.ready, false);
  assert.deepEqual(partialPivot.installedList.map(pack => pack.id), ['fr:en', 'de:en']);

  const readyToReturn = derivePacksView({
    from: 'de',
    to: 'en',
    state: { installed: ['de:en'] },
    pending: false,
    readFailed: false,
    canReturnToPage: true,
  });
  assert.equal(readyToReturn.ready, true);
  assert.equal(readyToReturn.installHidden, true);
  assert.equal(readyToReturn.requirementsText, 'Ready offline. Go back to your page and reopen the extension.');
  assert.match(readyToReturn.usageText, /^1 pack · .+ on disk$/);

  const downloading = derivePacksView({
    from: 'de',
    to: 'en',
    state: {
      installed: [],
      download: { pack: 'de:en', received: 500, total: 1000, saving: false, step: 1, steps: 1 },
      failure: { pack: 'de:en', error: 'download-failed' },
    },
    pending: false,
    readFailed: false,
    canReturnToPage: false,
  });
  assert.equal(downloading.transferHidden, false);
  assert.equal(downloading.installBarHidden, true);
  assert.equal(downloading.cancelDisabled, false);
  assert.equal(downloading.progressRatio, 0.5);
  assert.equal(downloading.actionsBlocked, true);
  assert.equal(downloading.noticeText, '');

  const failedDownload = derivePacksView({
    from: 'de',
    to: 'en',
    state: {
      installed: [],
      failure: { pack: 'de:en', error: 'download-failed' },
    },
    pending: false,
    readFailed: false,
    canReturnToPage: false,
  });
  assert.equal(failedDownload.noticeError, true);
  assert.match(failedDownload.noticeText, /Couldn’t download/);

  const explicitNotice = derivePacksView({
    from: 'de',
    to: 'en',
    state: {
      installed: [],
      failure: { pack: 'de:en', error: 'download-failed' },
    },
    pending: false,
    readFailed: false,
    canReturnToPage: false,
    notice: { text: 'Removed German → English.', error: false },
  });
  assert.equal(explicitNotice.noticeError, false);
  assert.equal(explicitNotice.noticeText, 'Removed German → English.');
});
