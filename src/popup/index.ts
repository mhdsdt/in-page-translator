import { inputs, outputs, routeFor } from '../shared/catalog';
import { catalogLanguage, fillLanguages, languageName, normalizeLanguage } from '../shared/languages';
import { engineRequest, requestEngine } from '../shared/offline';
import type { PageError, PageRequest, PageState } from '../shared/protocol';

const source = document.querySelector<HTMLSelectElement>('#source')!;
const target = document.querySelector<HTMLSelectElement>('#target')!;
const form = document.querySelector<HTMLFormElement>('#translation')!;
const action = document.querySelector<HTMLButtonElement>('#action')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const languagePacks = document.querySelector<HTMLButtonElement>('#language-packs')!;

const errors: Record<PageError, string> = {
  'language-unknown': 'Choose the page’s original language in From.',
  'same-language': 'Choose a different language in To.',
  'unsupported-pair': 'No language packs are available for this pair.',
  'missing-packs': 'Install the language packs for this pair first.',
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
let sending = false;
let warmedPair: string | undefined;
let installed: Set<string> | undefined;
let packRefresh: Promise<void> | undefined;

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
    if (state?.phase === 'error') state = { ...state, phase: 'original', error: undefined };
    render();
  });
}

languagePacks.addEventListener('click', () => { void openPacks(); });

async function openPacks(): Promise<void> {
  const url = new URL(chrome.runtime.getURL('packs.html'));
  const from = selectedSource();
  if (from) url.searchParams.set('from', from);
  if (target.value) url.searchParams.set('to', target.value);
  try {
    await chrome.tabs.create({ url: url.href });
  } catch {
    updateStatus('Couldn’t open the language pack manager.', true);
  }
}

function selectedSource(): string | undefined {
  return sourceSelection === 'auto'
    ? catalogLanguage(state?.declared ?? detected, inputs)
    : sourceSelection;
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
    if (tab?.id === undefined || !/^(https?|file):/u.test(tab.url ?? '')) {
      unavailable('Chrome restricts translation on this page.');
      return;
    }
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['page.js'],
    });
    if (!injection?.documentId) throw new Error('Missing document ID');
    address = { tabId: tab.id, documentId: injection.documentId };
    state = await send({ type: 'status' });
    if (state.phase === 'error' && state.source && state.target) {
      sourceSelection = inputs.includes(state.source) ? state.source : 'auto';
      if (outputs.includes(state.target)) target.value = state.target;
    }
    render();
  } catch {
    unavailable('Chrome couldn’t open this page for translation.');
  }
}

function refreshPacks(): Promise<void> {
  packRefresh ??= engineRequest({ type: 'packs-state' })
    .then(packs => { installed = new Set(packs.installed); })
    .catch(() => { installed = undefined; })
    .finally(() => {
      packRefresh = undefined;
      render();
    });
  return packRefresh;
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
  if (!state || action.disabled) return;
  const desiredTarget = target.value;
  if (!desiredTarget) return;
  const starting = canStart(state);
  const from = selectedSource();
  if (starting && from && needsPacks(from, desiredTarget)) {
    void chrome.storage.local.set({ targetLanguage: desiredTarget }).catch(() => {});
    await openPacks();
    return;
  }
  sending = true;
  cancelPoll();
  render();
  try {
    accept(await send(starting
      ? { type: 'start', source: from, target: desiredTarget }
      : { type: 'restore' }));
    if (starting) void chrome.storage.local.set({ targetLanguage: desiredTarget }).catch(() => {});
    schedulePoll();
  } catch {
    unavailable('Page changed. Reopen the extension to try again.');
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
    if (state === before && !sending) unavailable('Page changed. Reopen the extension to try again.');
  }
}

function canStart(page: PageState): boolean {
  return page.phase === 'original' || page.phase === 'error';
}

function unavailable(message: string): void {
  address = undefined;
  state = undefined;
  cancelPoll();
  source.disabled = target.disabled = action.disabled = true;
  updateStatus(message, true);
}

function render(): void {
  if (!state) return;
  const page = state;
  const starting = canStart(page);
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
  if (starting && installed && from && route.length && !missing && warmedPair !== from + ':' + to) {
    warmedPair = from + ':' + to;
    void requestEngine({ type: 'engine-prepare', from, to }).catch(() => {});
  }

  source.disabled = target.disabled = sending || !starting;
  const detecting = starting && sourceSelection === 'auto' && !page.declared && detection === 'pending';
  action.disabled = sending || page.phase === 'restoring' || detecting || Boolean(invalid);
  const pending = page.phase === 'preparing' || page.phase === 'translating';
  const label = missing ? 'Get language packs' : retry ? 'Retry translation'
    : starting ? 'Translate page' : pending ? 'Cancel and restore' : 'Show original';
  setAction(label, starting ? '→' : '↶');
  const message = detecting ? 'Detecting page language…'
    : invalid ? errors[from === to ? 'same-language' : 'unsupported-pair']
    : missing ? errors['missing-packs']
    : page.error === 'missing-packs' && installed ? 'Page is in its original language.'
    : statusMessage(page);

  updateStatus(message, Boolean(invalid) ||
    (page.phase === 'error' && (missing || page.error !== 'missing-packs')) || page.failed > 0);
  schedulePoll();
}

function updateStatus(message: string, error: boolean): void {
  if (status.textContent !== message) status.textContent = message;
  status.dataset.error = String(error);
}

function setAction(label: string, icon: string): void {
  if (action.firstChild?.textContent?.trim() !== label) {
    const glyph = document.createElement('span');
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = icon;
    action.replaceChildren(label, glyph);
  }
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
