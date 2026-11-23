import { inputs, outputs } from '../shared/catalog';
import { fillLanguages, pairName } from '../shared/languages';
import { engineRequest, OfflineError, requestEngine } from '../shared/offline';
import type { PackStatus } from '../shared/offline';
import { derivePacksView } from './view';
import type { InstalledPackView, RouteStepView } from './view';

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
  const view = derivePacksView({
    from: from.value,
    to: to.value,
    state,
    pending,
    readFailed,
    canReturnToPage: !returnPage.hidden,
    notice,
  });

  install.disabled = view.installDisabled;
  setText(routeSummary, view.routeSummary);
  setText(requirements, view.requirementsText);
  requirements.dataset.ready = String(view.ready);
  install.hidden = view.installHidden;
  renderRoute(view.route);

  transfer.hidden = view.transferHidden;
  installBar.hidden = view.installBarHidden;
  if (!view.transferHidden) {
    cancel.disabled = view.cancelDisabled;
    progress.value = view.progressRatio;
    setText(transferLabel, view.transferLabel);
    setText(transferBytes, view.transferBytes);
  }
  setText(message, view.noticeText);
  message.dataset.error = String(view.noticeError);

  empty.hidden = !view.installedEmpty;
  setText(usage, view.usageText);
  renderInstalled(view.installedList, view.actionsBlocked);

  if (focusInstall && state) {
    focusInstall = false;
    if (document.activeElement === document.body && !install.disabled) install.focus();
  }
  if (transferFocus && !pending) {
    const focused = document.activeElement;
    if (focused !== document.body && focused !== cancel && focused !== install) transferFocus = false;
    else if (!view.transferHidden && !view.cancelDisabled) cancel.focus();
    else if (view.transferHidden) {
      transferFocus = false;
      (view.ready ? returnPage.hidden ? requirements : returnPage : view.installDisabled ? from : install).focus();
    }
  }
}

function renderRoute(steps: readonly RouteStepView[]): void {
  const key = JSON.stringify(steps);
  if (key === routeKey) return;
  routeKey = key;
  const items = steps.map(step => {
    const item = document.createElement('li');
    item.dataset.installed = String(step.installed);
    const size = document.createElement('span');
    size.className = 'route-size';
    size.textContent = step.sizeText;
    item.append(icon(step.installed ? 'i-check' : 'i-download'), step.label, size);
    return item;
  });
  routeList.replaceChildren(...items);
}

function renderInstalled(installedList: readonly InstalledPackView[], blocked: boolean): void {
  const key = JSON.stringify(installedList.map(pack => pack.id));
  if (key !== listKey) {
    listKey = key;
    const before = seen;
    const fresh = state && before
      ? new Set(installedList.filter(pack => !before.has(pack.id)).map(pack => pack.id))
      : new Set<string>();
    if (state) seen = new Set(installedList.map(pack => pack.id));
    list.replaceChildren(...installedList.map(pack => packRow(pack, fresh.has(pack.id))));
  }
  for (const button of list.querySelectorAll('button')) button.disabled = blocked;
}

function packRow(pack: InstalledPackView, fresh: boolean): HTMLLIElement {
  const row = document.createElement('li');
  row.className = 'pack';
  if (fresh) row.dataset.fresh = 'true';

  const detail = document.createElement('div');
  detail.className = 'pack-text';
  const name = document.createElement('span');
  name.className = 'pack-name';
  name.textContent = pack.name;
  const bytes = document.createElement('small');
  bytes.textContent = pack.sizeText;
  detail.append(name, bytes);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'button button-danger';
  remove.setAttribute('aria-label', 'Remove ' + pack.name);
  remove.append(icon('i-trash'), 'Remove');
  remove.addEventListener('click', async () => {
    const focused = document.activeElement === remove;
    await change(() => requestEngine({ type: 'packs-remove', id: pack.id }), 'Removed ' + pairName(pack.id) + '.');
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
