import { packBatches } from '../shared/batch';
import { engineRequest, OfflineError, requestEngine } from '../shared/offline';
import type { EngineReply, Pair } from '../shared/offline';
import { splitText } from '../shared/text';

const REQUEST_TIMEOUT_MS = 45_000;
const IPC_BATCH_LIMITS = { maxItems: 24, maxChars: 2_400 };
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
    for (const batch of packBatches(all, item => item.text.length, IPC_BATCH_LIMITS)) {
      void dispatchBatch(batch);
    }
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
    if (!parts.length) return text;
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
