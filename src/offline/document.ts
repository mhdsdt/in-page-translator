import { takeBucketedBatch, takePrefixBatch } from '../shared/batch';
import { LruCache } from '../shared/cache';
import { inputs, outputs, routeFor } from '../shared/catalog';
import { catalogLanguage } from '../shared/languages';
import { MAX_TRANSLATION_CHARS, OfflineError } from '../shared/offline';
import type {
  AutoTranslateTarget, DownloadProgressEvent, EngineReply, EngineRequest, PacksEvent, Pair,
} from '../shared/offline';
import { Packs } from './packs';
import { Translator } from './translator';

interface Job {
  pair: Pair;
  text: string;
  html: boolean;
  reply: (result: EngineReply<string>) => void;
}

const MAX_QUEUED = 256;
const MAX_BATCH_REQUEST_ITEMS = 32;
const COALESCE_MS = 4;
const COALESCE_IMMEDIATE_ITEMS = 16;
const CACHE_CAPACITY = 4_096;
const MAX_CACHE_CHARS = 400;

const translationCache = new LruCache<string, string>(CACHE_CAPACITY);
const translator = new Translator();
const packs = new Packs({
  onPackSaved(pack, buffers, hasAutoTranslate) {
    if (!hasAutoTranslate) return;
    translator.seedPack(pack, buffers);
    translator.warmRuntime();
  },
  async onAutoTranslate(target: AutoTranslateTarget) {
    await chrome.runtime.sendMessage({ type: 'auto-translate-ready', target });
  },
  onPackRemoved(id) {
    translationCache.clear();
    translator.evictPack(id);
  },
  onStatusChange(status, autoTabId) {
    void chrome.runtime.sendMessage({ type: 'packs-updated', status } satisfies PacksEvent).catch(() => {});
    if (autoTabId !== undefined) {
      void chrome.runtime.sendMessage({
        type: 'download-progress',
        tabId: autoTabId,
        download: status.download,
      } satisfies DownloadProgressEvent).catch(() => {});
    }
  },
});

const queue: Job[] = [];
let inFlight = 0;
let burstBatches = 0;
let coalesceTimer: number | undefined;

function cacheKey(pair: Pair, html: boolean, text: string): string {
  return pair.from + '\0' + pair.to + '\0' + (html ? 'h' : 'p') + '\0' + text;
}

function storeTranslation(pair: Pair, html: boolean, text: string, value: string): void {
  if (text.length <= MAX_CACHE_CHARS) {
    translationCache.set(cacheKey(pair, html, text), value);
  }
}

function lookupTranslation(pair: Pair, html: boolean, text: string): string | undefined {
  if (text.length > MAX_CACHE_CHARS) return undefined;
  return translationCache.get(cacheKey(pair, html, text));
}

function scheduleDrain(): void {
  if (!queue.length) return;
  if (inFlight === 0 && queue.length < COALESCE_IMMEDIATE_ITEMS) {
    if (coalesceTimer !== undefined) return;
    coalesceTimer = window.setTimeout(() => {
      coalesceTimer = undefined;
      pump();
    }, COALESCE_MS);
    return;
  }
  window.clearTimeout(coalesceTimer);
  coalesceTimer = undefined;
  pump();
}

function pump(): void {
  while (queue.length) {
    const { pair } = queue[0]!;
    const samePair = (job: Job) => job.pair.from === pair.from && job.pair.to === pair.to;
    const route = routeFor(pair.from, pair.to);
    if (!route.length) {
      const invalid = takePrefixBatch(queue, samePair, job => job.text.length, { maxItems: 32, maxChars: 10_000 });
      queue.splice(0, invalid.length);
      for (const job of invalid) job.reply({ ok: false, error: 'unsupported-pair' });
      continue;
    }

    let queuedItems = 0;
    let queuedChars = 0;
    const scanCap = Math.min(queue.length, 64);
    for (let index = 0; index < scanCap; index++) {
      const job = queue[index]!;
      if (!samePair(job)) break;
      queuedItems++;
      queuedChars += job.text.length;
    }

    const slotIndex = translator.acquireReadySlot(route);
    if (slotIndex === undefined) {
      if (queuedItems >= 6 || queuedChars >= 240) {
        const desired = Math.min(translator.maxConcurrency(route), 1 + Math.ceil(queuedItems / 8));
        void packs.route(pair).then(verified => translator.warmExtra(verified, desired, scheduleDrain), () => {});
      }
      break;
    }

    const preferLong = burstBatches > 0 && translator.maxConcurrency(route) > 1;
    const batch = takeBucketedBatch(queue, samePair, job => job.text.length, {
      preferShort: burstBatches === 0,
      preferLong,
    });
    if (!batch.length) break;

    burstBatches++;
    inFlight++;
    void processBatch(slotIndex, pair, batch).finally(() => {
      inFlight--;
      if (!queue.length && inFlight === 0) burstBatches = 0;
      if (queue.length) scheduleDrain();
    });

    if (queue.length >= 6) {
      const desired = Math.min(translator.maxConcurrency(route), 1 + Math.ceil(queue.length / 8));
      void packs.route(pair).then(verified => translator.warmExtra(verified, desired, scheduleDrain), () => {});
    }
  }
}

async function processBatch(slotIndex: number, pair: Pair, batch: Job[]): Promise<void> {
  let route;
  try {
    route = await packs.route(pair);
  } catch (error) {
    const reply = failure(error);
    for (const job of batch) job.reply(reply);
    return;
  }

  try {
    const translations = await translator.translateOn(
      slotIndex,
      route,
      batch.map(({ text, html }) => ({ text, html })),
    );
    batch.forEach((job, index) => {
      const value = translations[index];
      if (value === undefined) {
        job.reply({ ok: false, error: 'engine-unavailable' });
      } else {
        storeTranslation(pair, job.html, job.text, value);
        job.reply({ ok: true, value });
      }
    });
  } catch (error) {
    if (batch.length === 1 || (error instanceof OfflineError &&
      (error.code === 'missing-packs' || error.code === 'unsupported-pair'))) {
      const reply = failure(error);
      for (const job of batch) job.reply(reply);
      return;
    }
    // Isolate a failing text so it never takes down unrelated siblings in the same batch.
    for (const job of batch) {
      try {
        const [value] = await translator.translate(route, [{ text: job.text, html: job.html }]);
        if (value === undefined) {
          job.reply({ ok: false, error: 'engine-unavailable' });
        } else {
          storeTranslation(pair, job.html, job.text, value);
          job.reply({ ok: true, value });
        }
      } catch (itemError) {
        job.reply(failure(itemError));
      }
    }
  }
}

function failure(error: unknown): EngineReply<never> {
  return { ok: false, error: error instanceof OfflineError ? error.code : 'engine-unavailable' };
}

chrome.runtime.onMessage.addListener((request: EngineRequest, sender, reply: (result: EngineReply<unknown>) => void) => {
  if (sender.id !== chrome.runtime.id || !request) return;
  const url = sender.url?.split('?')[0];
  const popup = url === chrome.runtime.getURL('popup.html');
  const manager = url === chrome.runtime.getURL('packs.html');
  const serviceWorker = !sender.tab && url === chrome.runtime.getURL('background.js');
  const content = Boolean(sender.tab) && !popup && !manager;

  if (request.type === 'engine-translate' && content) {
    const html = Boolean(request.html);
    if (typeof request.text !== 'string' || request.text.length > MAX_TRANSLATION_CHARS) {
      reply({ ok: false, error: 'busy' });
      return;
    }
    const cached = lookupTranslation(request, html, request.text);
    if (cached !== undefined) {
      reply({ ok: true, value: cached });
      return;
    }
    if (queue.length >= MAX_QUEUED) {
      reply({ ok: false, error: 'busy' });
      return;
    }
    queue.push({ pair: request, text: request.text, html, reply });
    scheduleDrain();
    return true;
  }

  if (request.type === 'engine-translate-batch' && content) {
    if (!Array.isArray(request.items) || request.items.length === 0 || request.items.length > MAX_BATCH_REQUEST_ITEMS) {
      reply({ ok: false, error: 'busy' });
      return;
    }
    const results = new Array<EngineReply<string>>(request.items.length);
    let remaining = 0;
    const finish = () => {
      if (remaining === 0) reply({ ok: true, value: results });
    };
    for (let index = 0; index < request.items.length; index++) {
      const item = request.items[index];
      if (!item || typeof item.text !== 'string' || item.text.length > MAX_TRANSLATION_CHARS) {
        results[index] = { ok: false, error: 'busy' };
        continue;
      }
      const html = Boolean(item.html);
      const cached = lookupTranslation(request, html, item.text);
      if (cached !== undefined) {
        results[index] = { ok: true, value: cached };
        continue;
      }
      if (queue.length >= MAX_QUEUED) {
        results[index] = { ok: false, error: 'busy' };
        continue;
      }
      remaining++;
      queue.push({
        pair: request,
        text: item.text,
        html,
        reply: itemReply => {
          results[index] = itemReply;
          remaining--;
          finish();
        },
      });
    }
    if (remaining === 0) {
      reply({ ok: true, value: results });
      return;
    }
    scheduleDrain();
    return true;
  }

  let work: Promise<unknown>;
  if (request.type === 'engine-prepare' && (content || popup)) {
    work = packs.route(request).then(route => translator.prepare(route));
  } else if (request.type === 'packs-state' && (popup || manager || serviceWorker)) {
    work = packs.status();
  } else if (request.type === 'packs-install' && (popup || manager || serviceWorker)) {
    work = packs.install(request, request.autoTranslate);
  } else if (request.type === 'packs-remove' && manager) {
    work = packs.remove(request.id);
  } else if (request.type === 'packs-cancel' && (popup || manager)) {
    packs.cancel();
    reply({ ok: true, value: undefined });
    return;
  } else if (request.type === 'shortcut-translate' && serviceWorker) {
    const from = catalogLanguage(request.rawSource, inputs);
    const to = catalogLanguage(request.rawTarget, outputs) ?? 'en';
    work = !from || from === to || !routeFor(from, to).length
      ? Promise.reject(new OfflineError('unsupported-pair'))
      : packs.install({ from, to }, {
          tabId: request.tabId,
          documentId: request.documentId,
          source: from,
          target: to,
        });
  } else return;

  void work.then(value => reply({ ok: true, value }), error => reply(failure(error)));
  return true;
});
