import type { EngineRequest, EngineReply } from '../shared/offline';

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
  if (sender.id !== chrome.runtime.id || request?.type !== 'engine-open') return;
  opening ??= openDocument().finally(() => { opening = undefined; });
  void opening.then(
    () => reply({ ok: true, value: undefined }),
    () => reply({ ok: false, error: 'engine-unavailable' }),
  );
  return true;
});
