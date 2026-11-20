import { catalog, formatSize, inputs, outputs, packBytes, routeFor } from '../shared/catalog';
import type { Pack } from '../shared/catalog';
import {
  downloadProgressRatio, formatDownloadBytes, formatDownloadFailure, formatDownloadLabel, totalPackBytes,
} from '../shared/format';
import { fillLanguages, pairName } from '../shared/languages';
import { engineRequest, OfflineError, requestEngine } from '../shared/offline';
import type { PackStatus } from '../shared/offline';

const from = document.querySelector<HTMLSelectElement>('#from')!;
const to = document.querySelector<HTMLSelectElement>('#to')!;
const form = document.querySelector<HTMLFormElement>('#install')!;
const routeSummary = document.querySelector<HTMLParagraphElement>('#route-summary')!;
const routeList = document.querySelector<HTMLOListElement>('#route')!;
const installBar = document.querySelector<HTMLDivElement>('#install-bar')!;
const requirements = document.querySelector<HTMLParagraphElement>('#requirements')!;
const install = document.querySelector<HTMLButtonElement>('#download')!;
const transfer = document.querySelector<HTMLElement>('#transfer')!;
const transferLabel = document.querySelector<HTMLParagraphElement>('#transfer-label')!;
const transferBytes = document.querySelector<HTMLSpanElement>('#transfer-bytes')!;
const progress = document.querySelector<HTMLProgressElement>('#progress')!;
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;
const message = document.querySelector<HTMLParagraphElement>('#message')!;
const empty = document.querySelector<HTMLDivElement>('#empty')!;
const usage = document.querySelector<HTMLSpanElement>('#usage')!;
const list = document.querySelector<HTMLUListElement>('#installed')!;
const installedTitle = document.querySelector<HTMLHeadingElement>('#installed-title')!;
const returnPage = document.querySelector<HTMLButtonElement>('#return-page')!;

const params = new URL(location.href).searchParams;
const returnTab = Number(params.get('tab'));
const preferredSource = params.get('from') ?? '';
const preferredTarget = params.get('to') ?? '';
fillLanguages(from, inputs);
fillLanguages(to, outputs);
from.value = inputs.includes(preferredSource) ? preferredSource : preferredTarget === 'en' ? 'es' : 'en';
to.value = outputs.includes(preferredTarget) ? preferredTarget : from.value === 'en' ? 'es' : 'en';

let state: PackStatus | undefined;
let pending = false;
let refreshing: Promise<void> | undefined;
let listKey: string | undefined;
let routeKey: string | undefined;
let seen: Set<string> | undefined;
let focusInstall = Number.isSafeInteger(returnTab) && returnTab > 0;
let notice: { text: string; error: boolean } | undefined;
let transferFocus = false;
let readFailed = false;

returnPage.hidden = !focusInstall;
returnPage.addEventListener('click', async () => {
  try {
    const tab = await chrome.tabs.update(returnTab, { active: true });
    if (tab) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    notice = { text: 'The original tab is unavailable. Open the extension from a web page to translate.', error: true };
    render();
  }
});

form.addEventListener('submit', event => {
  event.preventDefault();
  if (install.disabled) return;
  transferFocus = document.activeElement === install;
  void change(() => requestEngine({ type: 'packs-install', from: from.value, to: to.value }));
});
cancel.addEventListener('click', () => {
  transferFocus = document.activeElement === cancel;
  void change(() => requestEngine({ type: 'packs-cancel' }));
});
for (const select of [from, to]) select.addEventListener('change', render);
window.addEventListener('focus', () => { void refresh(); });

chrome.runtime.onMessage.addListener((msg: unknown, sender) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg !== 'object') return;
  if (sender.url?.split('?')[0] !== chrome.runtime.getURL('offline.html')) return;
  const event = msg as { type?: string; status?: PackStatus };
  if (event.type === 'packs-updated' && event.status) {
    state = event.status;
    readFailed = false;
    render();
  }
});

render();
void refresh();

function refresh(): Promise<void> {
  refreshing ??= readState().finally(() => { refreshing = undefined; });
  return refreshing;
}

async function readState(): Promise<void> {
  try {
    state = await engineRequest({ type: 'packs-state' });
    readFailed = false;
  } catch {
    state = undefined;
    readFailed = true;
  } finally {
    render();
  }
}

async function change(action: () => Promise<void>, success?: string): Promise<void> {
  if (pending) return;
  pending = true;
  notice = undefined;
  render();
  try {
    await action();
    if (success) notice = { text: success, error: false };
  } catch (error) {
    const text = error instanceof OfflineError && error.code === 'busy'
      ? 'Wait for the current download or cancel it first.'
      : 'Couldn’t update language packs. Try again.';
    notice = { text, error: true };
  } finally {
    await refreshing;
    pending = false;
    await refresh();
  }
}

function render(): void {
  const route = routeFor(from.value, to.value);
  const installed = new Set(state?.installed);
  const missing = route.filter(pack => !installed.has(pack.id));
  const active = state?.download;
  const blocked = pending || Boolean(active);
  install.disabled = blocked || !state || !missing.length;
  const ready = Boolean(state && route.length && !missing.length);
  setText(routeSummary, route.length > 1 ? 'This pair translates through English.'
    : 'Choose the languages you want to translate between.');
  setText(requirements, !route.length
    ? from.value === to.value ? 'Choose two different languages.' : 'This language pair is unavailable.'
    : !state ? readFailed ? 'Pack status unavailable.' : 'Checking installed packs…'
    : missing.length ? missing.length + (missing.length === 1 ? ' pack' : ' packs') +
      ' to download · ' + formatSize(totalPackBytes(missing, 'size'))
    : returnPage.hidden ? 'Ready offline. Open the extension on a web page to translate.'
    : 'Ready offline. Go back to your page and reopen the extension.');
  requirements.dataset.ready = String(ready);
  install.hidden = ready;
  renderRoute(route, state ? installed : undefined);

  transfer.hidden = !active;
  installBar.hidden = Boolean(active);
  if (active) {
    cancel.disabled = pending || active.saving;
    progress.value = downloadProgressRatio(active);
    setText(transferLabel, formatDownloadLabel(active));
    setText(transferBytes, active.saving ? '' : formatDownloadBytes(active));
  }
  renderNotice();
  renderInstalled(installed, blocked);
  if (focusInstall && state) {
    focusInstall = false;
    if (document.activeElement === document.body && !install.disabled) install.focus();
  }
  if (transferFocus && !pending) {
    const focused = document.activeElement;
    if (focused !== document.body && focused !== cancel && focused !== install) transferFocus = false;
    else if (active && !cancel.disabled) cancel.focus();
    else if (!active) {
      transferFocus = false;
      (ready ? returnPage.hidden ? requirements : returnPage : install.disabled ? from : install).focus();
    }
  }
}

function renderRoute(route: Pack[], installed: Set<string> | undefined): void {
  const key = JSON.stringify([route.map(pack => pack.id), installed && route.map(pack => installed.has(pack.id))]);
  if (key === routeKey) return;
  routeKey = key;
  const items: HTMLLIElement[] = [];
  for (const pack of route) {
    const owned = installed?.has(pack.id) ?? false;
    const item = document.createElement('li');
    item.dataset.installed = String(owned);
    const size = document.createElement('span');
    size.className = 'route-size';
    size.textContent = owned ? 'Installed' : installed ? formatSize(packBytes(pack, 'size')) : '';
    item.append(icon(owned ? 'i-check' : 'i-download'), pairName(pack.id), size);
    items.push(item);
  }
  routeList.replaceChildren(...items);
}

function renderInstalled(installed: Set<string>, blocked: boolean): void {
  const ids = [...installed].sort((a, b) => pairName(a).localeCompare(pairName(b), 'en'));
  empty.hidden = ids.length > 0 || !state;
  setText(usage, !state ? readFailed ? 'Storage status unavailable' : 'Checking storage…' : ids.length
    ? ids.length + (ids.length === 1 ? ' pack · ' : ' packs · ') +
      formatSize(ids.reduce((bytes, id) => bytes + packBytes(catalog.get(id)!, 'bytes'), 0)) + ' on disk'
    : '0 MiB on disk');
  const key = JSON.stringify(ids);
  if (key !== listKey) {
    listKey = key;
    const before = seen;
    const fresh = state && before ? new Set(ids.filter(id => !before.has(id))) : new Set<string>();
    if (state) seen = new Set(ids);
    list.replaceChildren(...ids.map(id => packRow(id, fresh.has(id))));
  }
  for (const button of list.querySelectorAll('button')) button.disabled = blocked;
}

function packRow(id: string, fresh: boolean): HTMLLIElement {
  const pack = catalog.get(id)!;
  const row = document.createElement('li');
  row.className = 'pack';
  if (fresh) row.dataset.fresh = 'true';

  const detail = document.createElement('div');
  detail.className = 'pack-text';
  const name = document.createElement('span');
  name.className = 'pack-name';
  name.textContent = pairName(id);
  const bytes = document.createElement('small');
  bytes.textContent = formatSize(packBytes(pack, 'bytes'));
  detail.append(name, bytes);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'button button-danger';
  remove.setAttribute('aria-label', 'Remove ' + pairName(id));
  remove.append(icon('i-trash'), 'Remove');
  remove.addEventListener('click', async () => {
    const focused = document.activeElement === remove;
    await change(() => requestEngine({ type: 'packs-remove', id }), 'Removed ' + pairName(id) + '.');
    if (focused && document.activeElement === document.body) {
      (remove.isConnected ? remove : installedTitle).focus();
    }
  });

  row.append(detail, remove);
  return row;
}

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + name);
  svg.append(use);
  return svg;
}

function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function renderNotice(): void {
  let current = readFailed
    ? { text: 'Couldn’t read installed language packs. Reload the manager to try again.', error: true }
    : notice;
  const failure = state?.failure;
  if (!current && failure && !state?.download && !pending) {
    current = { text: formatDownloadFailure(failure), error: true };
  }
  setText(message, current?.text ?? '');
  message.dataset.error = String(current?.error ?? false);
}
