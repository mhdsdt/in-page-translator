import { badgeForDownload, badgeForPage } from '../shared/badge';
import type { BadgeSpec } from '../shared/badge';
import type { DownloadProgressEvent, EngineReply, EngineRequest } from '../shared/offline';
import { packSelectionKey } from '../shared/protocol';
import type { PageEvent, PageRequest, PageState } from '../shared/protocol';

const DOCUMENT = 'offline.html';
const DEFAULT_TITLE = 'In-Page Translator';
let opening: Promise<void> | undefined;

type BackgroundMessage = EngineRequest | PageEvent | DownloadProgressEvent;

async function openDocument(): Promise<void> {
  const documents = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(DOCUMENT)],
  });
  if (documents.length) return;
  await chrome.offscreen.createDocument({
    url: DOCUMENT,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: 'Install language packs and run local translation in WebAssembly workers.',
  });
}

function ensureDocument(): Promise<void> {
  opening ??= openDocument().finally(() => { opening = undefined; });
  return opening;
}

function applyBadge(tabId: number, spec: BadgeSpec, title = DEFAULT_TITLE): void {
  void chrome.action.setBadgeText({ tabId, text: spec.text }).catch(() => {});
  void chrome.action.setTitle({ tabId, title }).catch(() => {});
  if (spec.text) {
    void chrome.action.setBadgeBackgroundColor({ tabId, color: spec.color }).catch(() => {});
    void chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' }).catch(() => {});
  }
}

async function toggleActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || !/^(https?|file):/u.test(tab.url ?? '')) return;

  const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['page.js'] });
  const documentId = injection?.documentId;
  if (!documentId) return;

  const state = await chrome.tabs.sendMessage(tab.id, { type: 'status' } satisfies PageRequest, { documentId }) as
    | PageState
    | undefined;
  if (!state || state.phase === 'restoring') return;

  if (state.phase === 'translated' || state.phase === 'translating' || state.phase === 'preparing') {
    await chrome.tabs.sendMessage(tab.id, { type: 'restore' } satisfies PageRequest, { documentId });
    return;
  }

  const prefs = await chrome.storage.local.get('targetLanguage').catch(() => ({})) as { targetLanguage?: string };
  const rawTarget = prefs.targetLanguage ?? chrome.i18n.getUILanguage() ?? 'en';
  const rawSource = state.declared ?? await chrome.tabs.detectLanguage(tab.id).catch(() => undefined);
  await ensureDocument();
  const reply = await chrome.runtime.sendMessage({
    type: 'shortcut-translate',
    tabId: tab.id,
    documentId,
    rawSource,
    rawTarget,
  } satisfies EngineRequest) as EngineReply<void> | undefined;
  if (!reply?.ok) {
    const reason = !reply ? 'Translation unavailable'
      : reply.error === 'unsupported-pair' ? 'Language pair unavailable'
      : reply.error === 'busy' ? 'Language pack download in progress'
      : 'Translation couldn’t start';
    applyBadge(tab.id, { text: '!', color: '#805015' }, `${DEFAULT_TITLE} — ${reason}`);
  }
}

chrome.runtime.onMessage.addListener((
  request: BackgroundMessage,
  sender,
  reply: (response: EngineReply<void>) => void,
) => {
  if (sender.id !== chrome.runtime.id) return;

  if (request?.type === 'engine-open') {
    void ensureDocument().then(
      () => reply({ ok: true, value: undefined }),
      () => reply({ ok: false, error: 'engine-unavailable' }),
    );
    return true;
  }

  if (request?.type === 'auto-translate-ready' && sender.url === chrome.runtime.getURL(DOCUMENT)) {
    const { tabId, documentId, source, target } = request.target;
    const start: PageRequest = { type: 'start', source, target };
    void chrome.tabs.sendMessage(tabId, start, { documentId }).then(
      () => reply({ ok: true, value: undefined }),
      () => reply({ ok: true, value: undefined }),
    );
    return true;
  }

  if (request?.type === 'page-state' && sender.tab?.id !== undefined) {
    applyBadge(sender.tab.id, badgeForPage(request.state));
    reply({ ok: true, value: undefined });
    return;
  }

  if (request?.type === 'download-progress' && sender.url === chrome.runtime.getURL(DOCUMENT)) {
    applyBadge(request.tabId, request.download ? badgeForDownload(request.download) : { text: '', color: '' });
    reply({ ok: true, value: undefined });
  }
});

chrome.commands.onCommand.addListener(command => {
  if (command === 'toggle-translation') {
    void toggleActiveTab().catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  void chrome.storage.session.remove(packSelectionKey(tabId)).catch(() => {});
});
