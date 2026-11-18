import { catalog, inputs, outputs, packBytes, routeFor } from '../shared/catalog';
import { fillLanguages, languageName } from '../shared/languages';
import { engineRequest, OfflineError, requestEngine } from '../shared/offline';
import type { PackStatus } from '../shared/offline';

const from = document.querySelector<HTMLSelectElement>('#from')!;
const to = document.querySelector<HTMLSelectElement>('#to')!;
const form = document.querySelector<HTMLFormElement>('#install')!;
const requirements = document.querySelector<HTMLParagraphElement>('#requirements')!;
const install = document.querySelector<HTMLButtonElement>('#download')!;
const transfer = document.querySelector<HTMLElement>('#transfer')!;
const transferLabel = document.querySelector<HTMLParagraphElement>('#transfer-label')!;
const progress = document.querySelector<HTMLProgressElement>('#progress')!;
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;
const message = document.querySelector<HTMLParagraphElement>('#message')!;
const empty = document.querySelector<HTMLParagraphElement>('#empty')!;
const list = document.querySelector<HTMLUListElement>('#installed')!;

const params = new URL(location.href).searchParams;
fillLanguages(from, inputs);
fillLanguages(to, outputs);
from.value = inputs.includes(params.get('from') ?? '') ? params.get('from')! : 'en';
to.value = outputs.includes(params.get('to') ?? '') ? params.get('to')! : from.value === 'en' ? 'es' : 'en';

let state: PackStatus | undefined;
let pending = false;
let refreshing: Promise<void> | undefined;
let timer: number | undefined;
let listKey: string | undefined;

form.addEventListener('submit', event => {
  event.preventDefault();
  if (install.disabled) return;
  void change(() => requestEngine({ type: 'packs-install', from: from.value, to: to.value }));
});
cancel.addEventListener('click', () => { void change(() => requestEngine({ type: 'packs-cancel' })); });
for (const select of [from, to]) select.addEventListener('change', render);
window.addEventListener('focus', () => { void refresh(); });

render();
void refresh();

function refresh(): Promise<void> {
  refreshing ??= readState().finally(() => { refreshing = undefined; });
  return refreshing;
}

async function readState(): Promise<void> {
  window.clearTimeout(timer);
  try {
    state = await engineRequest({ type: 'packs-state' });
  } catch {
    state = undefined;
    notify('Couldn’t read installed language packs. Reload the manager to try again.', true);
  } finally {
    render();
    if (state?.download) timer = window.setTimeout(() => { void refresh(); }, 250);
  }
}

async function change(action: () => Promise<void>): Promise<void> {
  if (pending) return;
  pending = true;
  notify('');
  render();
  try {
    await action();
  } catch (error) {
    notify(error instanceof OfflineError && error.code === 'busy'
      ? 'Wait for the current download or cancel it first.'
      : 'Couldn’t update language packs. Try again.', true);
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
  requirements.textContent = !route.length
    ? from.value === to.value ? 'Choose two different languages.' : 'This language pair is unavailable.'
    : !state ? 'Checking installed packs…'
    : missing.length ? 'Download ' + missing.map(pack => pairName(pack.id)).join(' and ') +
      ' · ' + size(missing.reduce((bytes, pack) => bytes + packBytes(pack, 'size'), 0))
    : 'Ready offline. Open the extension on a web page to translate.';
  transfer.hidden = !active;
  if (active) {
    cancel.disabled = pending || active.saving;
    progress.value = active.saving ? 1 : active.received / active.total;
    transferLabel.textContent = (active.saving ? 'Saving ' : 'Downloading ') + pairName(active.pack) +
      (active.saving ? '…' : ' · ' + Math.floor(progress.value * 100) + '%');
  }
  if (state?.failure && !active && !pending) {
    const failure = state.failure;
    notify(failure.error === 'storage-failed'
      ? 'Couldn’t save ' + pairName(failure.pack) + '. Check available storage and try again.'
      : failure.error === 'integrity-failed'
        ? 'The ' + pairName(failure.pack) + ' download did not pass verification. Try again.'
        : 'Couldn’t download ' + pairName(failure.pack) + '. Check the connection and try again.', true);
  }
  renderInstalled(installed, blocked);
}

function renderInstalled(installed: Set<string>, blocked: boolean): void {
  const ids = [...installed].sort((a, b) => pairName(a).localeCompare(pairName(b), 'en'));
  empty.hidden = ids.length > 0 || !state;
  const key = JSON.stringify([ids, blocked]);
  if (key === listKey) return;
  listKey = key;
  list.replaceChildren(...ids.map(id => {
    const pack = catalog.get(id)!;
    const row = document.createElement('li');
    const detail = document.createElement('div');
    detail.textContent = pairName(id);
    const bytes = document.createElement('small');
    bytes.textContent = size(packBytes(pack, 'bytes')) + ' on this device';
    detail.append(bytes);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.disabled = blocked;
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', 'Remove ' + pairName(id));
    remove.onclick = () => { void change(() => requestEngine({ type: 'packs-remove', id })); };
    row.append(detail, remove);
    return row;
  }));
}

function notify(text: string, error = false): void {
  if (message.textContent !== text) message.textContent = text;
  message.dataset.error = String(error);
}

function pairName(id: string): string {
  return id.split(':').map(languageName).join(' → ');
}

function size(bytes: number): string {
  return Math.round(bytes / 2 ** 20) + ' MiB';
}
