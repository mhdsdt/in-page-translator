import { formatSize, inputs, routeFor } from '../shared/catalog';
import type { Pack } from '../shared/catalog';
import {
  downloadProgressRatio, formatDownloadBytes, formatDownloadLabel, totalPackBytes,
} from '../shared/format';
import { catalogLanguage, languageName } from '../shared/languages';
import type { DownloadStatus, Pair } from '../shared/offline';
import type { PageError, PageState } from '../shared/protocol';

export type Tone = 'idle' | 'busy' | 'success' | 'warn' | 'error' | 'off';
export type ActionKind = 'translate' | 'download' | 'retry' | 'cancel' | 'restore';
export type ReadinessTone = 'ready' | 'warn' | 'progress';

export interface PopupViewInput {
  page: PageState;
  sourceSelection: string;
  target: string;
  detected?: string;
  detection: 'idle' | 'pending' | 'done';
  installed?: ReadonlySet<string>;
  checkingPacks: boolean;
  activeDownload?: DownloadStatus;
  downloadError?: string;
  sending: boolean;
}

export interface PopupView {
  sourceValue: string;
  targetValue: string;
  autoLabel: string;
  selectsDisabled: boolean;
  actionKind: ActionKind;
  actionLabel: string;
  actionDisabled: boolean;
  statusText: string;
  tone: Tone;
  progressDeterminate: boolean;
  progressRatio: number;
  readinessHidden: boolean;
  readinessText: string;
  readinessTone: ReadinessTone;
  warmPair?: Pair;
  pollPage: boolean;
}

const errors: Record<PageError, string> = {
  'language-unknown': 'Choose the page’s original language in From.',
  'same-language': 'Choose a different language in To.',
  'unsupported-pair': 'No language packs are available for this pair.',
  'missing-packs': 'Download language pack to translate this page.',
  'engine-unavailable': 'The local translator couldn’t start. Try again.',
  'translation-failed': 'Couldn’t translate the visible text. Show original and try again.',
  'no-text': 'No text in view yet. Scroll to translate more.',
};

export function canStartPage(page: PageState): boolean {
  return page.phase === 'original' || page.phase === 'error';
}

export function resolveSource(
  sourceSelection: string,
  declared: string | undefined,
  detected: string | undefined,
): string | undefined {
  return sourceSelection === 'auto'
    ? catalogLanguage(declared ?? detected, inputs)
    : sourceSelection;
}

export function needsPacksForRoute(
  route: readonly Pack[],
  installed: ReadonlySet<string> | undefined,
  pageError: PageError | undefined,
): boolean {
  return installed
    ? route.some(pack => !installed.has(pack.id))
    : pageError === 'missing-packs';
}

export function derivePopupView(input: PopupViewInput): PopupView {
  const { page, detected, detection, installed, checkingPacks, activeDownload, downloadError, sending } = input;
  const starting = canStartPage(page);
  const retry = page.error === 'engine-unavailable';
  const effectiveSourceSelection = retry && page.source && inputs.includes(page.source)
    ? page.source
    : input.sourceSelection;
  const sourceValue = !starting && page.source ? page.source : effectiveSourceSelection;
  const targetValue = (!starting || retry) && page.target ? page.target : input.target;

  const likely = page.declared ?? detected;
  const autoLabel = likely ? 'Auto · ' + languageName(likely) : 'Detect automatically';
  const from = resolveSource(effectiveSourceSelection, page.declared, detected);
  const route = from ? routeFor(from, targetValue) : [];
  const missing = starting && Boolean(from && needsPacksForRoute(route, installed, page.error));
  const invalid = starting && Boolean(from && !route.length);
  const unknown = starting && !from;
  const checking = starting && route.length > 0 && !installed && checkingPacks;
  const detecting = starting && effectiveSourceSelection === 'auto' && !page.declared && detection === 'pending';

  const selectsDisabled = sending || !starting || Boolean(activeDownload);

  if (activeDownload) {
    const ratio = downloadProgressRatio(activeDownload);
    return {
      sourceValue,
      targetValue,
      autoLabel,
      selectsDisabled,
      actionKind: 'cancel',
      actionLabel: 'Cancel download',
      actionDisabled: sending || activeDownload.saving,
      statusText: formatDownloadLabel(activeDownload, true),
      tone: 'busy',
      progressDeterminate: !activeDownload.saving,
      progressRatio: ratio,
      readinessHidden: false,
      readinessText: activeDownload.saving
        ? 'Verifying and saving to device…'
        : formatDownloadBytes(activeDownload),
      readinessTone: 'progress',
      pollPage: false,
    };
  }

  const pending = page.phase === 'preparing' || page.phase === 'translating';
  const actionDisabled = sending || page.phase === 'restoring' || detecting || checking || invalid || unknown;

  let actionKind: ActionKind;
  let actionLabel: string;
  if (missing) {
    actionKind = 'download';
    actionLabel = 'Download & translate';
  } else if (retry) {
    actionKind = 'retry';
    actionLabel = 'Retry translation';
  } else if (starting) {
    actionKind = 'translate';
    actionLabel = 'Translate page';
  } else if (pending) {
    actionKind = 'cancel';
    actionLabel = 'Cancel and restore';
  } else {
    actionKind = 'restore';
    actionLabel = 'Show original';
  }

  const statusText = detecting ? 'Detecting page language…'
    : invalid ? errors[from === targetValue ? 'same-language' : 'unsupported-pair']
    : checking ? 'Checking installed language packs…'
    : downloadError ? downloadError
    : missing ? errors['missing-packs']
    : unknown ? errors['language-unknown']
    : page.error === 'missing-packs' && installed ? 'Page is in its original language.'
    : statusMessage(page);

  const busy = sending || detecting || checking || pending || page.phase === 'restoring';
  const failed = Boolean(downloadError) || (page.phase === 'error' && (missing || page.error !== 'missing-packs'));
  const tone: Tone = busy ? 'busy'
    : downloadError ? 'error'
    : invalid || missing || unknown || page.error === 'no-text' || page.failed > 0 ? 'warn'
    : failed ? 'error'
    : page.phase === 'translated' ? 'success'
    : 'idle';

  const showReadiness = Boolean(starting && !detecting && route.length && installed);
  let readinessText = '';
  let readinessTone: ReadinessTone = 'ready';
  if (showReadiness && installed) {
    const needed = route.filter(pack => !installed.has(pack.id));
    if (needed.length) {
      readinessText = (needed.length === 1 ? '1 pack' : needed.length + ' packs') +
        ' · ' + formatSize(totalPackBytes(needed, 'size')) + ' download';
      readinessTone = 'warn';
    } else {
      readinessText = route.length > 1 ? 'Ready offline · via English' : 'Ready offline';
      readinessTone = 'ready';
    }
  }

  const warmPair = starting && installed && from && route.length && !missing
    ? { from, to: targetValue }
    : undefined;

  return {
    sourceValue,
    targetValue,
    autoLabel,
    selectsDisabled,
    actionKind,
    actionLabel,
    actionDisabled,
    statusText,
    tone,
    progressDeterminate: false,
    progressRatio: 0,
    readinessHidden: !showReadiness,
    readinessText,
    readinessTone,
    warmPair,
    pollPage: !starting,
  };
}

function statusMessage(page: PageState): string {
  if (page.error) return errors[page.error];
  switch (page.phase) {
    case 'original':
      return 'Page is in its original language.';
    case 'preparing':
      return 'Loading local translation model…';
    case 'translating':
      return page.updated ? 'Translating… ' + page.updated.toLocaleString() + ' updates' : 'Translating page…';
    case 'translated':
      if (!page.target) return 'Visible text translated.';
      return page.failed
        ? 'Translated to ' + languageName(page.target) + '. Some text couldn’t be translated.'
        : 'Translated to ' + languageName(page.target) + '. Scroll to translate more.';
    case 'restoring':
      return 'Restoring original text…';
    case 'error':
      return 'Couldn’t start translation.';
  }
}
