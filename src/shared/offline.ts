export const MAX_TRANSLATION_CHARS = 1_200;

export interface Pair { from: string; to: string }

export interface ModelBuffers {
  model: ArrayBuffer;
  shortlist: ArrayBuffer;
  vocabs: ArrayBuffer[];
}

export type PackError = 'busy' | 'unsupported-pair' | 'missing-packs' | 'download-failed' | 'integrity-failed' | 'storage-failed' | 'engine-unavailable';

export interface DownloadStatus {
  pack: string;
  received: number;
  total: number;
  saving: boolean;
}

export interface PackStatus {
  installed: string[];
  download?: DownloadStatus;
  failure?: { pack: string; error: PackError };
}

interface Calls {
  'engine-open': { request: object; result: void };
  'engine-prepare': { request: Pair; result: void };
  'engine-translate': { request: Pair & { text: string }; result: string };
  'packs-state': { request: object; result: PackStatus };
  'packs-install': { request: Pair; result: void };
  'packs-cancel': { request: object; result: void };
  'packs-remove': { request: { id: string }; result: void };
}

export type EngineRequest = {
  [Type in keyof Calls]: { type: Type } & Calls[Type]['request'];
}[keyof Calls];

export type EngineReply<T> = { ok: true; value: T } | { ok: false; error: PackError };

export class OfflineError extends Error {
  constructor(readonly code: PackError) {
    super(code);
  }
}

export async function requestEngine<Message extends EngineRequest>(
  message: Message,
): Promise<Calls[Message['type']]['result']> {
  const result: EngineReply<Calls[Message['type']]['result']> | undefined =
    await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new OfflineError(result?.error ?? 'engine-unavailable');
  return result.value;
}

export async function engineRequest<Message extends EngineRequest>(
  message: Message,
): Promise<Calls[Message['type']]['result']> {
  await requestEngine({ type: 'engine-open' });
  return requestEngine(message);
}
