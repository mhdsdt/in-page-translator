import { inputs, outputs, routeFor } from '../shared/catalog';
import { formatDownloadFailure } from '../shared/format';
import { catalogLanguage, fillLanguages, normalizeLanguage } from '../shared/languages';
import { engineRequest, OfflineError, requestEngine } from '../shared/offline';
import type { PackStatus } from '../shared/offline';
import { packSelectionKey } from '../shared/protocol';
import type { PackSelection, PageRequest, PageState } from '../shared/protocol';
import { canStartPage, derivePopupView, needsPacksForRoute, resolveSource } from './view';
import type { ActionKind, Tone } from './view';

const MAX_RECENT_TARGETS = 3;
const DETECT_LANGUAGE_TIMEOUT_MS = 2_000;

const source = document.querySelector<HTMLSelectElement>('#source')!;
const target = document.querySelector<HTMLSelectElement>('#target')!;
const swap = document.querySelector<HTMLButtonElement>('#swap')!;
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
let recentTargets: string[] = [];
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

swap.addEventListener('click', () => {
  if (swap.disabled || !state) return;
  const currentFrom = resolveSource(sourceSelection, state.declared, detected);
  const currentTo = target.value;
  if (!currentFrom || currentFrom === currentTo || !outputs.includes(currentFrom) || !inputs.includes(currentTo)) return;
  sourceSelection = currentTo;
  target.value = currentFrom;
  downloadError = undefined;
  if (state.phase === 'error') state = { ...state, phase: 'original', error: undefined };
  render();
});

languagePacks.addEventListener('click', () => { void openPacks(); });

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return;
  const msg = message as { type?: string; state?: PageState; status?: PackStatus };
  if (msg.type === 'page-state' && msg.state &&
    sender.tab?.id === address?.tabId && sender.documentId === address?.documentId) {
    if (!canStartPage(msg.state) && packStatus?.download) {
      packStatus = { ...packStatus, download: undefined };
      wasDownloading = false;
      void refreshPacks();
    }
    accept(msg.state);
    render();
  } else if (msg.type === 'packs-updated' && msg.status &&
    sender.url?.split('?')[0] === chrome.runtime.getURL('offline.html')) {
    applyPackStatus(msg.status);
    render();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === address?.tabId && changeInfo.status === 'loading') {
    unavailable('Page changed. Reopen the extension to try again.', 'warn');
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  if (tabId === address?.tabId) {
    unavailable('Page changed. Reopen the extension to try again.', 'warn');
  }
});

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

function recordTarget(code: string): void {
  recentTargets = [code, ...recentTargets.filter(item => item !== code)].slice(0, MAX_RECENT_TARGETS);
  void chrome.storage.local.set({ targetLanguage: code, recentTargets }).catch(() => {});
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
      chrome.storage.local.get(['targetLanguage', 'recentTargets']).catch(() => ({})),
    ]);
    const prefs = preferences as { targetLanguage?: string; recentTargets?: unknown };
    const savedRecents = Array.isArray(prefs.recentTargets)
      ? prefs.recentTargets.filter((c): c is string => typeof c === 'string' && outputs.includes(c)).slice(0, MAX_RECENT_TARGETS)
      : [];
    if (savedRecents.length) {
      recentTargets = savedRecents;
      const defaultTarget = target.value;
      target.replaceChildren();
      fillLanguages(target, outputs, recentTargets);
      target.value = defaultTarget;
    }
    target.value = catalogLanguage(prefs.targetLanguage, outputs) ?? target.value;
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

function applyPackStatus(packs: PackStatus): void {
  const finishedDownload = wasDownloading && !packs.download;
  packStatus = packs;
  installed = new Set(packs.installed);
  wasDownloading = Boolean(packs.download);
  if (packs.download) {
    downloadError = undefined;
  } else if (finishedDownload) {
    if (packs.failure) {
      downloadError = formatDownloadFailure(packs.failure);
    } else if (address && state) {
      void syncPageStatus();
    }
  }
}

function refreshPacks(): Promise<void> {
  packRefresh ??= engineRequest({ type: 'packs-state' })
    .then(packs => applyPackStatus(packs))
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
  const timeout = window.setTimeout(finish, DETECT_LANGUAGE_TIMEOUT_MS);
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

async function syncPageStatus(): Promise<void> {
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
    recordTarget(desiredTarget);
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
  render();
  try {
    accept(await send(starting
      ? { type: 'start', source: from, target: desiredTarget }
      : { type: 'restore' }));
    if (starting) {
      recordTarget(desiredTarget);
      if (resumedSelection) void chrome.storage.session.remove(packSelectionKey(address.tabId)).catch(() => {});
      resumedSelection = false;
    }
  } catch {
    unavailable('Page changed. Reopen the extension to try again.', 'warn');
  } finally {
    sending = false;
    render();
  }
}

function unavailable(message: string, tone: Tone): void {
  address = undefined;
  state = undefined;
  source.disabled = target.disabled = swap.disabled = action.disabled = true;
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
  swap.disabled = !view.canSwap;

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
