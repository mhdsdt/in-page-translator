import type { EngineRequest, EngineReply } from '../shared/offline';
import { packSelectionKey } from '../shared/protocol';
import type { PageRequest } from '../shared/protocol';

const DOCUMENT = 'offline.html';
let opening: Promise<void> | undefined;

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

chrome.runtime.onMessage.addListener((request: EngineRequest, sender, reply: (response: EngineReply<void>) => void) => {
  if (sender.id !== chrome.runtime.id) return;

  if (request?.type === 'engine-open') {
    opening ??= openDocument().finally(() => { opening = undefined; });
    void opening.then(
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
});

chrome.tabs.onRemoved.addListener(tabId => {
  void chrome.storage.session.remove(packSelectionKey(tabId)).catch(() => {});
});
