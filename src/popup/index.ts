import { formatSize, inputs, outputs, packBytes, routeFor } from '../shared/catalog';
import type { Pack } from '../shared/catalog';
import { catalogLanguage, fillLanguages, languageName, normalizeLanguage, pairName } from '../shared/languages';
import { engineRequest, OfflineError, requestEngine } from '../shared/offline';
import type { DownloadStatus, PackStatus } from '../shared/offline';
import { packSelectionKey } from '../shared/protocol';
import type { PackSelection, PageError, PageRequest, PageState } from '../shared/protocol';

const source = document.querySelector<HTMLSelectElement>('#source')!;
const target = document.querySelector<HTMLSelectElement>('#target')!;
const form = document.querySelector<HTMLFormElement>('#translation')!;
const action = document.querySelector<HTMLButtonElement>('#action')!;
const actionLabel = action.querySelector<HTMLSpanElement>('.action-label')!;
const actionIcon = action.querySelector<SVGUseElement>('use')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const panel = document.querySelector<HTMLDivElement>('#status-panel')!;
const meterFill = document.querySelector<HTMLSpanElement>('#meter-fill')!;
const readiness = document.querySelector<HTMLParagraphElement>('#readiness')!;
const site = document.querySelector<HTMLParagraphElement>('#site')!;
const languagePacks = document.querySelector<HTMLButtonElement>('#language-packs')!;

type Tone = 'idle' | 'busy' | 'success' | 'warn' | 'error' | 'off';
type ActionKind = 'translate' | 'download' | 'retry' | 'cancel' | 'restore';

const actionIcons: Record<ActionKind, string> = {
  translate: '#i-arrow-right',
  download: '#i-download',
  retry: '#i-retry',
  cancel: '#i-stop',
  restore: '#i-undo',
};

const errors: Record<PageError, string> = {
  'language-unknown': 'Choose the page’s original language in From.',
  'same-language': 'Choose a different language in To.',
  'unsupported-pair': 'No language packs are available for this pair.',
  'missing-packs': 'Download language pack to translate this page.',
  'engine-unavailable': 'The local translator couldn’t start. Try again.',
  'translation-failed': 'Couldn’t translate the visible text. Show original and try again.',
  'no-text': 'No text in view yet. Scroll to translate more.',
};

interface PageAddress { tabId: number; documentId: string }

let address: PageAddress | undefined;
let state: PageState | undefined;
let detected: string | undefined;
let detection: 'idle' | 'pending' | 'done' = 'idle';
let sourceSelection = 'auto';
let timer: number | undefined;
let packTimer: number | undefined;
let sending = false;
let warmedPair: string | undefined;
let packStatus: PackStatus | undefined;
let installed: Set<string> | undefined;
let packRefresh: Promise<void> | undefined;
let wasDownloading = false;
let downloadError: string | undefined;
let resumedSelection = false;
let openingPacks = false;

source.add(new Option('Detect automatically', 'auto'));
fillLanguages(source, inputs);
fillLanguages(target, outputs);
target.value = catalogLanguage(chrome.i18n.getUILanguage(), outputs) ?? 'en';

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void submit();
});
for (const select of [source, target]) {
  select.addEventListener('change', () => {
    if (select === source) sourceSelection = source.value;
    downloadError = undefined;
    if (state?.phase === 'error') state = { ...state, phase: 'original', error: undefined };
    render();
  });
}

languagePacks.addEventListener('click', () => { void openPacks(); });

async function openPacks(): Promise<void> {
  if (openingPacks) return;
  openingPacks = true;
  const url = new URL(chrome.runtime.getURL('packs.html'));
  const from = selectedSource();
  if (from) url.searchParams.set('from', from);
  if (target.value) url.searchParams.set('to', target.value);
  if (address) {
    url.searchParams.set('tab', String(address.tabId));
    const packSelection: PackSelection = { documentId: address.documentId, source: sourceSelection, target: target.value };
    await chrome.storage.session.set({ [packSelectionKey(address.tabId)]: packSelection }).catch(() => {});
  }
  try {
    await chrome.tabs.create({ url: url.href });
  } catch {
    updateStatus('Couldn’t open the language pack manager.', 'error');
  } finally {
    openingPacks = false;
  }
}

function selectedSource(): string | undefined {
  return sourceSelection === 'auto'
    ? catalogLanguage(state?.declared ?? detected, inputs)
    : sourceSelection;
}

function describePage(url: string | undefined): string {
  if (!url) return 'Current page';
  try {
    const { protocol, hostname, pathname } = new URL(url);
    if (protocol === 'file:') return decodeURIComponent(pathname.split('/').pop() || 'Local file');
    if (/^https?:$/u.test(protocol)) return hostname.replace(/^www\./u, '');
  } catch {}
  return 'Browser page';
}

void connect();

async function connect(): Promise<void> {
  void refreshPacks();
  try {
    const [[tab], preferences] = await Promise.all([
      chrome.tabs.query({ active: true, currentWindow: true }),
      chrome.storage.local.get('targetLanguage').catch(() => ({})),
    ]);
    const saved = (preferences as { targetLanguage?: string }).targetLanguage;
    target.value = catalogLanguage(saved, outputs) ?? target.value;
    site.textContent = describePage(tab?.url);
    if (tab?.id === undefined || !/^(https?|file):/u.test(tab.url ?? '')) {
      unavailable('Chrome restricts translation on this page. Try a web page in another tab.', 'off');
      return;
    }
    const key = packSelectionKey(tab.id);
    const [[injection], session] = await Promise.all([
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['page.js'] }),
      chrome.storage.session.get<Record<string, PackSelection | undefined>>(key).catch(() => undefined),
    ]);
    if (!injection?.documentId) throw new Error('Missing document ID');
    address = { tabId: tab.id, documentId: injection.documentId };
    state = await send({ type: 'status' });
    const selection = session?.[key];
    if (selection?.documentId === address.documentId && canStart(state)) {
      resumedSelection = true;
      sourceSelection = inputs.includes(selection.source) ? selection.source : 'auto';
      if (outputs.includes(selection.target)) target.value = selection.target;
      if (state.phase === 'error') state = { ...state, phase: 'original', error: undefined };
    } else if (state.phase === 'error' && state.source && state.target) {
      sourceSelection = inputs.includes(state.source) ? state.source : 'auto';
      if (outputs.includes(state.target)) target.value = state.target;
    }
    render();
  } catch {
    unavailable('Chrome couldn’t open this page for translation.', 'error');
  }
}

function refreshPacks(): Promise<void> {
  window.clearTimeout(packTimer);
  packTimer = undefined;
  packRefresh ??= engineRequest({ type: 'packs-state' })
    .then(packs => {
      const finishedDownload = wasDownloading && !packs.download;
      packStatus = packs;
      installed = new Set(packs.installed);
      wasDownloading = Boolean(packs.download);
      if (packs.download) {
        downloadError = undefined;
        packTimer = window.setTimeout(() => { void refreshPacks(); }, 250);
      } else if (finishedDownload) {
        if (packs.failure) {
          downloadError = formatDownloadFailure(packs.failure);
        } else if (address && state) {
          void poll();
        }
      }
    })
    .catch(() => {
      packStatus = undefined;
      installed = undefined;
    })
    .finally(() => {
      packRefresh = undefined;
      render();
    });
  return packRefresh;
}

function formatDownloadFailure(failure: NonNullable<PackStatus['failure']>): string {
  const pair = pairName(failure.pack);
  if (failure.error === 'storage-failed') return 'Couldn’t save ' + pair + '. Check available storage and try again.';
  if (failure.error === 'integrity-failed') return 'The ' + pair + ' download did not pass verification. Try again.';
  return 'Couldn’t download ' + pair + '. Check the connection and try again.';
}

function needsPacks(from: string, to: string): boolean {
  const route = routeFor(from, to);
  return installed ? route.some(pack => !installed?.has(pack.id)) : state?.error === 'missing-packs';
}

function accept(page: PageState): void {
  const oldError = state?.error;
  state = page;
  if (page.error === 'missing-packs' && oldError !== page.error) void refreshPacks();
}

function detectSource(page: PageState): void {
  if (!address || detection !== 'idle' || !canStart(page) || page.declared) return;
  detection = 'pending';
  const finish = () => {
    detection = 'done';
    render();
  };
  // Some pages never return a language. Leave the manual choice available throughout.
  const timeout = window.setTimeout(finish, 2_000);
  void chrome.tabs.detectLanguage(address.tabId)
    .then(code => { detected = normalizeLanguage(code); })
    .catch(() => {})
    .finally(() => {
      window.clearTimeout(timeout);
      finish();
    });
}

function send(request: PageRequest): Promise<PageState> {
  if (!address) throw new Error('No active document');
  return chrome.tabs.sendMessage(address.tabId, request, { documentId: address.documentId });
}

async function submit(): Promise<void> {
  if (!state || !address || action.disabled || openingPacks) return;

  if (packStatus?.download) {
    sending = true;
    render();
    try {
      await requestEngine({ type: 'packs-cancel' });
    } catch {}
    sending = false;
    await refreshPacks();
    return;
  }

  const desiredTarget = target.value;
  if (!desiredTarget) return;
  const starting = canStart(state);
  const from = selectedSource();

  if (starting && from && needsPacks(from, desiredTarget)) {
    downloadError = undefined;
    sending = true;
    render();
    void chrome.storage.local.set({ targetLanguage: desiredTarget }).catch(() => {});
    if (resumedSelection) {
      void chrome.storage.session.remove(packSelectionKey(address.tabId)).catch(() => {});
      resumedSelection = false;
    }
    try {
      wasDownloading = true;
      await engineRequest({
        type: 'packs-install',
        from,
        to: desiredTarget,
        autoTranslate: {
          tabId: address.tabId,
          documentId: address.documentId,
          source: from,
          target: desiredTarget,
        },
      });
    } catch (error) {
      wasDownloading = false;
      downloadError = error instanceof OfflineError && error.code === 'busy'
        ? 'Wait for the current download or cancel it first.'
        : 'Couldn’t start the download. Try again.';
    } finally {
      sending = false;
      await refreshPacks();
    }
    return;
  }

  downloadError = undefined;
  sending = true;
  cancelPoll();
  render();
  try {
    accept(await send(starting
      ? { type: 'start', source: from, target: desiredTarget }
      : { type: 'restore' }));
    if (starting) {
      void chrome.storage.local.set({ targetLanguage: desiredTarget }).catch(() => {});
      if (resumedSelection) void chrome.storage.session.remove(packSelectionKey(address.tabId)).catch(() => {});
      resumedSelection = false;
    }
    schedulePoll();
  } catch {
    unavailable('Page changed. Reopen the extension to try again.', 'warn');
  } finally {
    sending = false;
    render();
  }
}

function schedulePoll(): void {
  if (timer !== undefined || !state || canStart(state)) return;
  timer = window.setTimeout(() => { void poll(); }, state.phase === 'translated' ? 1_000 : 200);
}

function cancelPoll(): void {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
}

async function poll(): Promise<void> {
  timer = undefined;
  // A submit can race an in-flight poll. The poll must then discard its old snapshot.
  const before = state;
  try {
    const next = await send({ type: 'status' });
    if (state !== before || sending) return;
    accept(next);
    render();
  } catch {
    if (state === before && !sending) unavailable('Page changed. Reopen the extension to try again.', 'warn');
  }
}

function canStart(page: PageState): boolean {
  return page.phase === 'original' || page.phase === 'error';
}

function unavailable(message: string, tone: Tone): void {
  address = undefined;
  state = undefined;
  cancelPoll();
  window.clearTimeout(packTimer);
  packTimer = undefined;
  source.disabled = target.disabled = action.disabled = true;
  readiness.hidden = true;
  panel.dataset.progress = 'false';
  updateStatus(message, tone);
}

function render(): void {
  if (!state) return;
  const page = state;
  const starting = canStart(page);
  const activeDownload = packStatus?.download;
  const retry = page.error === 'engine-unavailable';
  if (retry && page.source && inputs.includes(page.source)) sourceSelection = page.source;
  detectSource(page);
  source.value = !starting && page.source ? page.source : sourceSelection;
  if ((!starting || retry) && page.target) target.value = page.target;
  const likely = page.declared ?? detected;
  const automatic = source.options.item(0);
  if (automatic) automatic.text = likely ? 'Auto · ' + languageName(likely) : 'Detect automatically';

  const from = selectedSource();
  const to = target.value;
  const route = from ? routeFor(from, to) : [];
  const missing = starting && Boolean(from && needsPacks(from, to));
  const invalid = starting && from && !route.length;
  const unknown = starting && !from;
  const checking = starting && route.length > 0 && !installed && packRefresh !== undefined;
  if (starting && !activeDownload && installed && from && route.length && !missing && warmedPair !== from + ':' + to) {
    warmedPair = from + ':' + to;
    void requestEngine({ type: 'engine-prepare', from, to }).catch(() => {});
  }

  source.disabled = target.disabled = sending || !starting || Boolean(activeDownload);
  const detecting = starting && sourceSelection === 'auto' && !page.declared && detection === 'pending';

  if (activeDownload) {
    action.disabled = sending || activeDownload.saving;
    setAction('cancel', 'Cancel download');
    renderDownload(activeDownload);
    return;
  }

  panel.dataset.progress = 'false';
  action.disabled = sending || page.phase === 'restoring' || detecting || checking || Boolean(invalid) || unknown;
  const pending = page.phase === 'preparing' || page.phase === 'translating';
  if (missing) setAction('download', 'Download & translate');
  else if (retry) setAction('retry', 'Retry translation');
  else if (starting) setAction('translate', 'Translate page');
  else if (pending) setAction('cancel', 'Cancel and restore');
  else setAction('restore', 'Show original');

  const message = detecting ? 'Detecting page language…'
    : invalid ? errors[from === to ? 'same-language' : 'unsupported-pair']
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
  updateStatus(message, tone);
  renderReadiness(starting && !detecting && route.length ? route : []);
  schedulePoll();
}

function renderDownload(active: DownloadStatus): void {
  const stepLabel = active.steps > 1 ? ' (' + active.step + ' of ' + active.steps + ')' : '';
  const verb = active.saving ? 'Saving ' : 'Downloading ';
  const ratio = active.saving ? 1 : active.total ? Math.min(1, active.received / active.total) : 0;

  updateStatus(verb + pairName(active.pack) + stepLabel + '…', 'busy');
  panel.dataset.progress = active.saving ? 'false' : 'true';
  meterFill.style.transform = 'scaleX(' + ratio + ')';

  readiness.hidden = false;
  readiness.dataset.tone = 'progress';
  const detail = active.saving
    ? 'Verifying and saving to device…'
    : formatSize(active.received) + ' of ' + formatSize(active.total) + ' · ' + Math.floor(ratio * 100) + '%';
  if (readiness.textContent !== detail) readiness.textContent = detail;
}

function renderReadiness(route: Pack[]): void {
  readiness.hidden = !route.length || !installed;
  if (readiness.hidden) return;
  const needed = route.filter(pack => !installed?.has(pack.id));
  const text = needed.length
    ? (needed.length === 1 ? '1 pack' : needed.length + ' packs') +
      ' · ' + formatSize(needed.reduce((bytes, pack) => bytes + packBytes(pack, 'size'), 0)) + ' download'
    : route.length > 1 ? 'Ready offline · via English' : 'Ready offline';
  if (readiness.textContent !== text) readiness.textContent = text;
  readiness.dataset.tone = needed.length ? 'warn' : 'ready';
}

function updateStatus(message: string, tone: Tone): void {
  if (status.textContent !== message) status.textContent = message;
  panel.dataset.tone = tone;
}

function setAction(kind: ActionKind, label: string): void {
  if (action.dataset.kind === kind && actionLabel.textContent === label) return;
  action.dataset.kind = kind;
  actionLabel.textContent = label;
  actionIcon.setAttribute('href', actionIcons[kind]);
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
