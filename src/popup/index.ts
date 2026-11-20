import { inputs, outputs, routeFor } from '../shared/catalog';
import { formatDownloadFailure } from '../shared/format';
import { catalogLanguage, fillLanguages, normalizeLanguage } from '../shared/languages';
import { engineRequest, OfflineError, requestEngine } from '../shared/offline';
import type { PackStatus } from '../shared/offline';
import { packSelectionKey } from '../shared/protocol';
import type { PackSelection, PageRequest, PageState } from '../shared/protocol';
import { canStartPage, derivePopupView, needsPacksForRoute, resolveSource } from './view';
import type { ActionKind, Tone } from './view';

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

const actionIcons: Record<ActionKind, string> = {
  translate: '#i-arrow-right',
  download: '#i-download',
  retry: '#i-retry',
  cancel: '#i-stop',
  restore: '#i-undo',
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
  const from = resolveSource(sourceSelection, state?.declared, detected);
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
    if (selection?.documentId === address.documentId && canStartPage(state)) {
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

function accept(page: PageState): void {
  const oldError = state?.error;
  state = page;
  if (page.error === 'missing-packs' && oldError !== page.error) void refreshPacks();
}

function detectSource(page: PageState): void {
  if (!address || detection !== 'idle' || !canStartPage(page) || page.declared) return;
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
  const starting = canStartPage(state);
  const from = resolveSource(sourceSelection, state.declared, detected);
  const route = from ? routeFor(from, desiredTarget) : [];

  if (starting && from && needsPacksForRoute(route, installed, state.error)) {
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
  if (timer !== undefined || !state || canStartPage(state)) return;
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
  if (page.error === 'engine-unavailable' && page.source && inputs.includes(page.source)) {
    sourceSelection = page.source;
  }
  detectSource(page);

  const view = derivePopupView({
    page,
    sourceSelection,
    target: target.value,
    detected,
    detection,
    installed,
    checkingPacks: packRefresh !== undefined,
    activeDownload: packStatus?.download,
    downloadError,
    sending,
  });

  source.value = view.sourceValue;
  target.value = view.targetValue;
  const automatic = source.options.item(0);
  if (automatic) automatic.text = view.autoLabel;
  source.disabled = target.disabled = view.selectsDisabled;

  action.disabled = view.actionDisabled;
  setAction(view.actionKind, view.actionLabel);
  updateStatus(view.statusText, view.tone);

  panel.dataset.progress = String(view.progressDeterminate);
  if (view.progressDeterminate) {
    meterFill.style.transform = 'scaleX(' + view.progressRatio + ')';
  }

  readiness.hidden = view.readinessHidden;
  if (!view.readinessHidden) {
    if (readiness.textContent !== view.readinessText) readiness.textContent = view.readinessText;
    readiness.dataset.tone = view.readinessTone;
  }

  if (view.warmPair) {
    const pairKey = view.warmPair.from + ':' + view.warmPair.to;
    if (warmedPair !== pairKey) {
      warmedPair = pairKey;
      void requestEngine({ type: 'engine-prepare', ...view.warmPair }).catch(() => {});
    }
  }
  if (view.pollPage) schedulePoll();
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
