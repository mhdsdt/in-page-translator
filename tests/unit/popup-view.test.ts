import assert from 'node:assert/strict';
import test from 'node:test';
import { derivePopupView } from '../../src/popup/view';
import type { PopupViewInput } from '../../src/popup/view';

function base(overrides: Partial<PopupViewInput> = {}): PopupViewInput {
  return {
    page: { phase: 'original', declared: 'de', updated: 0, failed: 0 },
    sourceSelection: 'auto',
    target: 'en',
    detection: 'done',
    installed: new Set(['de:en']),
    checkingPacks: false,
    sending: false,
    ...overrides,
  };
}

test('derivePopupView: ready installed pair enables Translate page and requests model warm-up', () => {
  const view = derivePopupView(base());
  assert.equal(view.actionKind, 'translate');
  assert.equal(view.actionLabel, 'Translate page');
  assert.equal(view.actionDisabled, false);
  assert.equal(view.tone, 'idle');
  assert.equal(view.readinessText, 'Ready offline');
  assert.deepEqual(view.warmPair, { from: 'de', to: 'en' });
  assert.equal(view.pollPage, false);
});

test('derivePopupView: missing pack offers direct Download & translate with download size', () => {
  const view = derivePopupView(base({ installed: new Set() }));
  assert.equal(view.actionKind, 'download');
  assert.equal(view.actionLabel, 'Download & translate');
  assert.equal(view.actionDisabled, false);
  assert.equal(view.tone, 'warn');
  assert.match(view.readinessText, /^1 pack · .+ download$/);
  assert.equal(view.warmPair, undefined);
});

test('derivePopupView: active download displays determinate progress and Cancel download', () => {
  const view = derivePopupView(base({
    installed: new Set(),
    activeDownload: { pack: 'de:en', received: 5 * 2 ** 20, total: 10 * 2 ** 20, saving: false, step: 1, steps: 2 },
  }));
  assert.equal(view.actionKind, 'cancel');
  assert.equal(view.actionLabel, 'Cancel download');
  assert.equal(view.actionDisabled, false);
  assert.equal(view.selectsDisabled, true);
  assert.equal(view.tone, 'busy');
  assert.equal(view.progressDeterminate, true);
  assert.equal(view.progressRatio, 0.5);
  assert.equal(view.statusText, 'Downloading German → English (1 of 2)…');
  assert.equal(view.readinessText, '5 MiB of 10 MiB · 50%');
});

test('derivePopupView: saving disables cancel and switches meter to indeterminate', () => {
  const view = derivePopupView(base({
    activeDownload: { pack: 'de:en', received: 10, total: 10, saving: true, step: 1, steps: 1 },
  }));
  assert.equal(view.actionDisabled, true);
  assert.equal(view.progressDeterminate, false);
  assert.equal(view.readinessText, 'Verifying and saving to device…');
});

test('derivePopupView: handles same-language, unknown source, retry, translating, and partial failure states', () => {
  const same = derivePopupView(base({ target: 'de' }));
  assert.equal(same.actionDisabled, true);
  assert.equal(same.statusText, 'Choose a different language in To.');

  const unknown = derivePopupView(base({ page: { phase: 'original', updated: 0, failed: 0 } }));
  assert.equal(unknown.actionDisabled, true);
  assert.equal(unknown.statusText, 'Choose the page’s original language in From.');

  const retry = derivePopupView(base({
    page: { phase: 'error', source: 'de', target: 'en', updated: 0, failed: 0, error: 'engine-unavailable' },
  }));
  assert.equal(retry.actionKind, 'retry');
  assert.equal(retry.actionLabel, 'Retry translation');
  assert.equal(retry.tone, 'error');

  const translating = derivePopupView(base({
    page: { phase: 'translating', source: 'de', target: 'en', updated: 14, failed: 0 },
  }));
  assert.equal(translating.actionKind, 'cancel');
  assert.equal(translating.actionLabel, 'Cancel and restore');
  assert.equal(translating.pollPage, true);
  assert.equal(translating.statusText, 'Translating… 14 updates');

  const partial = derivePopupView(base({
    page: { phase: 'translated', source: 'de', target: 'en', updated: 10, failed: 2 },
  }));
  assert.equal(partial.actionKind, 'restore');
  assert.equal(partial.tone, 'warn');
  assert.match(partial.statusText, /Some text couldn’t be translated/);
});
