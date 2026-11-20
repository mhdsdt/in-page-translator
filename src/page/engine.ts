import { engineRequest, MAX_TRANSLATION_CHARS, OfflineError, requestEngine } from '../shared/offline';
import type { EngineReply, Pair } from '../shared/offline';

const REQUEST_TIMEOUT_MS = 45_000;
const IPC_BATCH_MAX_TEXTS = 24;
const IPC_BATCH_MAX_CHARS = 2_400;
const TARGET_CHUNK_CHARS = 800;
const CACHE_ENTRIES = 2_048;
const BUSY_DELAYS = [50, 150, 450] as const;

interface TranslatorInstance {
  translate(text: string, options: { signal: AbortSignal }): Promise<string>;
}

interface PendingItem {
  text: string;
  signal: AbortSignal;
  resolve: (value: string) => void;
  reject: (error: unknown) => void;
}

export async function openEngine(pair: Pair, signal: AbortSignal): Promise<TranslatorInstance> {
  await engineRequest({ type: 'engine-prepare', ...pair }, { signal, timeoutMs: REQUEST_TIMEOUT_MS });
  signal.throwIfAborted();

  let reopening: Promise<void> | undefined;
  let queued: PendingItem[] = [];
  let flushScheduled = false;

  function ensureOpen(reqSignal: AbortSignal): Promise<void> {
    reopening ??= requestEngine({ type: 'engine-open' }, { signal: reqSignal, timeoutMs: REQUEST_TIMEOUT_MS })
      .finally(() => { reopening = undefined; });
    return reopening;
  }

  async function dispatchBatch(items: PendingItem[]): Promise<void> {
    const active = items.filter(item => {
      if (!item.signal.aborted) return true;
      item.reject(item.signal.reason);
      return false;
    });
    if (!active.length) return;

    const texts = active.map(item => item.text);
    const send = () => requestEngine(
      { type: 'engine-translate-batch', ...pair, texts },
      { signal, timeoutMs: REQUEST_TIMEOUT_MS },
    );

    let replies: EngineReply<string>[];
    try {
      replies = await send();
    } catch (error) {
      if (signal.aborted) {
        for (const item of active) item.reject(signal.reason);
        return;
      }
      if (error instanceof OfflineError && error.disconnected) {
        try {
          await ensureOpen(signal);
          replies = await send();
        } catch (retryError) {
          for (const item of active) item.reject(retryError);
          return;
        }
      } else {
        for (const item of active) item.reject(error);
        return;
      }
    }

    active.forEach((item, index) => {
      const reply = replies[index];
      if (!reply) item.reject(new OfflineError('engine-unavailable'));
      else if (reply.ok) item.resolve(reply.value);
      else item.reject(new OfflineError(reply.error));
    });
  }

  function flush(): void {
    flushScheduled = false;
    const all = queued;
    queued = [];
    if (!all.length) return;

    let batch: PendingItem[] = [];
    let chars = 0;
    for (const item of all) {
      if (batch.length >= IPC_BATCH_MAX_TEXTS || (batch.length > 0 && chars + item.text.length > IPC_BATCH_MAX_CHARS)) {
        void dispatchBatch(batch);
        batch = [];
        chars = 0;
      }
      batch.push(item);
      chars += item.text.length;
    }
    if (batch.length) void dispatchBatch(batch);
  }

  function enqueueOnce(text: string, reqSignal: AbortSignal): Promise<string> {
    reqSignal.throwIfAborted();
    return new Promise<string>((resolve, reject) => {
      queued.push({ text, signal: reqSignal, resolve, reject });
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(flush);
      }
    });
  }

  return {
    async translate(text, { signal: reqSignal }) {
      for (const delay of BUSY_DELAYS) {
        reqSignal.throwIfAborted();
        try {
          return await enqueueOnce(text, reqSignal);
        } catch (error) {
          if (!(error instanceof OfflineError) || error.code !== 'busy') throw error;
          await sleep(delay, reqSignal);
        }
      }
      reqSignal.throwIfAborted();
      return enqueueOnce(text, reqSignal);
    },
  };
}

// Reuse in-flight and completed translations of repeated text.
export class TranslationCache {
  private readonly entries = new Map<string, Promise<string>>();

  constructor(
    private readonly translator: TranslatorInstance,
    private readonly signal: AbortSignal,
  ) {}

  async translate(text: string): Promise<string> {
    const parts = Array.from(splitText(text));
    if (parts.length === 1) return this.translatePart(parts[0]!);
    const translated = await Promise.all(parts.map(part => this.translatePart(part)));
    return translated.join('');
  }

  private async translatePart(part: string): Promise<string> {
    this.signal.throwIfAborted();
    const core = part.trim();
    if (!core) return part;
    const leading = part.length - part.trimStart().length;
    const trailing = part.length - part.trimEnd().length;
    return part.slice(0, leading) + await this.lookup(core) + part.slice(part.length - trailing);
  }

  private lookup(text: string): Promise<string> {
    const present = this.entries.get(text);
    if (present) {
      this.entries.delete(text);
      this.entries.set(text, present);
      return present;
    }
    const pending = this.translator.translate(text, { signal: this.signal })
      .then(result => result.trim() || text)
      .catch((error: unknown) => {
        if (this.entries.get(text) === pending) this.entries.delete(text);
        throw error;
      });

    this.entries.set(text, pending);
    if (this.entries.size > CACHE_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    return pending;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const SENTENCE_BREAK = /[\n。！？；.!?;]/u;

function* splitText(text: string): Generator<string> {
  if (text.length <= MAX_TRANSLATION_CHARS) {
    yield text;
    return;
  }
  let start = 0;
  while (text.length - start > MAX_TRANSLATION_CHARS) {
    const limit = Math.min(start + MAX_TRANSLATION_CHARS, text.length);
    const target = Math.min(start + TARGET_CHUNK_CHARS, limit);
    const floor = start + Math.floor(TARGET_CHUNK_CHARS / 2);
    let end = -1;

    // Prefer sentence boundaries near the target chunk size for better translation quality.
    for (let candidate = limit - 1; candidate >= floor; candidate--) {
      const char = text.charAt(candidate);
      if (SENTENCE_BREAK.test(char)) {
        const after = candidate + 1;
        if (char === '\n' || /[\u3002\uff01\uff1f\uff1b]/u.test(char) || after === limit || /\s/u.test(text.charAt(after))) {
          end = after;
          if (candidate <= target) break;
        }
      }
    }
    if (end === -1) {
      for (let candidate = limit; candidate > floor; candidate--) {
        if (/\s/u.test(text.charAt(candidate))) {
          end = candidate;
          break;
        }
      }
    }
    if (end <= start) end = limit;

    // Keep a UTF-16 surrogate pair together when a long input has no boundary.
    const code = text.charCodeAt(end);
    if (code >= 0xdc00 && code <= 0xdfff && end > start + 1) end--;
    yield text.slice(start, end);
    start = end;
  }
  if (start < text.length) yield text.slice(start);
}
