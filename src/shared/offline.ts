export const MAX_TRANSLATION_CHARS = 1_200;

export interface Pair { from: string; to: string }

export interface TranslateItem {
  text: string;
  html?: boolean;
}

export interface AutoTranslateTarget {
  tabId: number;
  documentId: string;
  source: string;
  target: string;
}

export interface ModelBuffers {
  model: ArrayBuffer;
  shortlist: ArrayBuffer;
  vocabs: ArrayBuffer[];
}

export type PackError =
  | 'busy'
  | 'unsupported-pair'
  | 'missing-packs'
  | 'download-failed'
  | 'integrity-failed'
  | 'storage-failed'
  | 'engine-unavailable';

export interface DownloadStatus {
  pack: string;
  received: number;
  total: number;
  saving: boolean;
  step: number;
  steps: number;
}

export interface PackStatus {
  installed: string[];
  download?: DownloadStatus;
  failure?: { pack: string; error: PackError };
}

interface Calls {
  'engine-open': { request: object; result: void };
  'engine-prepare': { request: Pair; result: void };
  'engine-translate': { request: Pair & { text: string; html?: boolean }; result: string };
  'engine-translate-batch': { request: Pair & { items: TranslateItem[] }; result: EngineReply<string>[] };
  'packs-state': { request: object; result: PackStatus };
  'packs-install': { request: Pair & { autoTranslate?: AutoTranslateTarget }; result: void };
  'packs-cancel': { request: object; result: void };
  'packs-remove': { request: { id: string }; result: void };
  'shortcut-translate': {
    request: { tabId: number; documentId: string; rawSource?: string; rawTarget?: string };
    result: void;
  };
  'auto-translate-ready': { request: { target: AutoTranslateTarget }; result: void };
}

export interface PacksEvent {
  type: 'packs-updated';
  status: PackStatus;
}

export interface DownloadProgressEvent {
  type: 'download-progress';
  tabId: number;
  download?: DownloadStatus;
}

export type EngineRequest = {
  [Type in keyof Calls]: { type: Type } & Calls[Type]['request'];
}[keyof Calls];

export type EngineReply<T> = { ok: true; value: T } | { ok: false; error: PackError };

export class OfflineError extends Error {
  constructor(
    readonly code: PackError,
    readonly disconnected = false,
  ) {
    super(code);
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function requestEngine<Message extends EngineRequest>(
  message: Message,
  options?: RequestOptions,
): Promise<Calls[Message['type']]['result']> {
  options?.signal?.throwIfAborted();
  let result: EngineReply<Calls[Message['type']]['result']> | undefined;
  try {
    const send = chrome.runtime.sendMessage(message) as Promise<
      EngineReply<Calls[Message['type']]['result']> | undefined
    >;
    result = options?.signal || options?.timeoutMs !== undefined
      ? await raceSignal(send, options.signal, options.timeoutMs)
      : await send;
  } catch (error) {
    if (options?.signal?.aborted) throw options.signal.reason;
    if (error instanceof OfflineError) throw error;
    throw new OfflineError('engine-unavailable', true);
  }
  if (!result) throw new OfflineError('engine-unavailable', true);
  if (!result.ok) throw new OfflineError(result.error);
  return result.value;
}

export async function engineRequest<Message extends EngineRequest>(
  message: Message,
  options?: RequestOptions,
): Promise<Calls[Message['type']]['result']> {
  await requestEngine({ type: 'engine-open' }, options);
  return requestEngine(message, options);
}

function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal!.reason);
    };
    const timer = timeoutMs !== undefined
      ? setTimeout(() => {
          cleanup();
          reject(new OfflineError('engine-unavailable', true));
        }, timeoutMs)
      : undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error);
      },
    );
  });
}
