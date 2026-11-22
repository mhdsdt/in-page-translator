import { packBatches } from '../shared/batch';
import { LruCache } from '../shared/cache';
import { engineRequest, MAX_TRANSLATION_CHARS, OfflineError, requestEngine } from '../shared/offline';
import type { EngineReply, Pair } from '../shared/offline';
import { splitText } from '../shared/text';

const REQUEST_TIMEOUT_MS = 45_000;
const IPC_BATCH_LIMITS = { maxItems: 8, maxChars: 600 };
const CACHE_ENTRIES = 2_048;
const BUSY_DELAYS = [50, 150, 450] as const;

interface TranslatorInstance {
  translate(text: string, options: { signal: AbortSignal; html?: boolean }): Promise<string>;
}

interface PendingItem {
  text: string;
  html: boolean;
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

    const send = () => requestEngine(
      {
        type: 'engine-translate-batch',
        ...pair,
        items: active.map(({ text, html }) => ({ text, html })),
      },
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
    all.sort((a, b) => a.text.length - b.text.length);
    const short: PendingItem[] = [];
    const medium: PendingItem[] = [];
    const long: PendingItem[] = [];
    for (const item of all) {
      const len = item.text.length;
      if (len <= 40) short.push(item);
      else if (len <= 120) medium.push(item);
      else long.push(item);
    }
    for (const group of [short, medium, long]) {
      if (!group.length) continue;
      for (const batch of packBatches(group, item => item.text.length, IPC_BATCH_LIMITS)) {
        void dispatchBatch(batch);
      }
    }
  }

  function enqueueOnce(text: string, html: boolean, reqSignal: AbortSignal): Promise<string> {
    reqSignal.throwIfAborted();
    return new Promise<string>((resolve, reject) => {
      queued.push({ text, html, signal: reqSignal, resolve, reject });
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(flush);
      }
    });
  }

  return {
    async translate(text, { signal: reqSignal, html = false }) {
      for (const delay of BUSY_DELAYS) {
        reqSignal.throwIfAborted();
        try {
          return await enqueueOnce(text, html, reqSignal);
        } catch (error) {
          if (!(error instanceof OfflineError) || error.code !== 'busy') throw error;
          await sleep(delay, reqSignal);
        }
      }
      reqSignal.throwIfAborted();
      return enqueueOnce(text, html, reqSignal);
    },
  };
}

// Reuse in-flight and completed translations of repeated text and inline HTML units.
export class TranslationCache {
  private readonly entries = new LruCache<string, Promise<string>>(CACHE_ENTRIES);

  constructor(
    private readonly translator: TranslatorInstance,
    private readonly signal: AbortSignal,
  ) {}

  async translate(text: string): Promise<string> {
    const parts = Array.from(splitText(text));
    if (!parts.length) return text;
    if (parts.length === 1) return this.translatePart(parts[0]!, false);
    const translated = await Promise.all(parts.map(part => this.translatePart(part, false)));
    return translated.join('');
  }

  translateHtml(html: string): Promise<string> {
    return this.translatePart(html, true);
  }

  private async translatePart(part: string, html: boolean): Promise<string> {
    this.signal.throwIfAborted();
    const core = part.trim();
    if (!core || core.length > MAX_TRANSLATION_CHARS) return part;
    const leading = part.length - part.trimStart().length;
    const trailing = part.length - part.trimEnd().length;
    const key = (html ? 'h:' : 'p:') + core;
    return part.slice(0, leading) + await this.lookup(key, core, html) + part.slice(part.length - trailing);
  }

  private lookup(key: string, text: string, html: boolean): Promise<string> {
    const present = this.entries.get(key);
    if (present) return present;
    const pending = this.translator.translate(text, { signal: this.signal, html })
      .then(result => result.trim() || text)
      .catch((error: unknown) => {
        if (this.entries.peek(key) === pending) this.entries.delete(key);
        throw error;
      });

    this.entries.set(key, pending);
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
