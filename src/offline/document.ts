import { takePrefixBatch } from '../shared/batch';
import { MAX_TRANSLATION_CHARS, OfflineError } from '../shared/offline';
import type { AutoTranslateTarget, EngineReply, EngineRequest, Pair } from '../shared/offline';
import { Packs } from './packs';
import { Translator } from './translator';

interface Job {
  pair: Pair;
  text: string;
  reply: (result: EngineReply<string>) => void;
}

const MAX_QUEUED = 128;
const BATCH_LIMITS = { maxItems: 32, maxChars: 2_400 };
const COALESCE_MS = 4;

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
    translator.evictPack(id);
  },
});

const queue: Job[] = [];
let running = false;
let coalesceTimer: number | undefined;

function scheduleDrain(): void {
  if (running || !queue.length) return;
  if (batchReady()) {
    window.clearTimeout(coalesceTimer);
    coalesceTimer = undefined;
    void drain();
    return;
  }
  if (coalesceTimer !== undefined) return;
  coalesceTimer = window.setTimeout(() => {
    coalesceTimer = undefined;
    void drain();
  }, COALESCE_MS);
}

function batchReady(): boolean {
  if (queue.length >= BATCH_LIMITS.maxItems) return true;
  let chars = 0;
  for (const job of queue) {
    chars += job.text.length;
    if (chars >= BATCH_LIMITS.maxChars) return true;
  }
  return false;
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const { pair } = queue[0]!;
      const batch = takeBatch(pair);
      let route;
      try {
        route = await packs.route(pair);
      } catch (error) {
        const reply = failure(error);
        for (const job of batch) job.reply(reply);
        continue;
      }

      try {
        const translations = await translator.translate(route, batch.map(job => job.text));
        batch.forEach((job, index) => {
          const value = translations[index];
          job.reply(value === undefined ? { ok: false, error: 'engine-unavailable' } : { ok: true, value });
        });
      } catch (error) {
        if (batch.length === 1 || (error instanceof OfflineError &&
          (error.code === 'missing-packs' || error.code === 'unsupported-pair'))) {
          const reply = failure(error);
          for (const job of batch) job.reply(reply);
          continue;
        }
        // Isolate a failing text so it never takes down unrelated siblings in the same batch.
        for (const job of batch) {
          try {
            const [value] = await translator.translate(route, [job.text]);
            job.reply(value === undefined ? { ok: false, error: 'engine-unavailable' } : { ok: true, value });
          } catch (itemError) {
            job.reply(failure(itemError));
          }
        }
      }
    }
  } finally {
    running = false;
    if (queue.length) scheduleDrain();
  }
}

function takeBatch(pair: Pair): Job[] {
  const batch = takePrefixBatch(
    queue,
    job => job.pair.from === pair.from && job.pair.to === pair.to,
    job => job.text.length,
    BATCH_LIMITS,
  );
  queue.splice(0, batch.length);
  return batch;
}

function failure(error: unknown): EngineReply<never> {
  return { ok: false, error: error instanceof OfflineError ? error.code : 'engine-unavailable' };
}

chrome.runtime.onMessage.addListener((request: EngineRequest, sender, reply: (result: EngineReply<unknown>) => void) => {
  if (sender.id !== chrome.runtime.id || !request) return;
  const url = sender.url?.split('?')[0];
  const popup = url === chrome.runtime.getURL('popup.html');
  const manager = url === chrome.runtime.getURL('packs.html');
  const content = Boolean(sender.tab) && !popup && !manager;

  if (request.type === 'engine-translate' && content) {
    if (typeof request.text !== 'string' || request.text.length > MAX_TRANSLATION_CHARS || queue.length >= MAX_QUEUED) {
      reply({ ok: false, error: 'busy' });
      return;
    }
    queue.push({ pair: request, text: request.text, reply });
    scheduleDrain();
    return true;
  }

  if (request.type === 'engine-translate-batch' && content) {
    if (!Array.isArray(request.texts) || request.texts.length === 0 || request.texts.length > BATCH_LIMITS.maxItems) {
      reply({ ok: false, error: 'busy' });
      return;
    }
    const results = new Array<EngineReply<string>>(request.texts.length);
    let remaining = 0;
    const finish = () => {
      if (remaining === 0) reply({ ok: true, value: results });
    };
    for (let index = 0; index < request.texts.length; index++) {
      const text = request.texts[index];
      if (typeof text !== 'string' || text.length > MAX_TRANSLATION_CHARS || queue.length >= MAX_QUEUED) {
        results[index] = { ok: false, error: 'busy' };
        continue;
      }
      remaining++;
      queue.push({
        pair: request,
        text,
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
  } else if (request.type === 'packs-state' && (popup || manager)) {
    work = packs.status();
  } else if (request.type === 'packs-install' && (popup || manager)) {
    work = packs.install(request, request.autoTranslate);
  } else if (request.type === 'packs-remove' && manager) {
    work = packs.remove(request.id);
  } else if (request.type === 'packs-cancel' && (popup || manager)) {
    packs.cancel();
    reply({ ok: true, value: undefined });
    return;
  } else return;

  void work.then(value => reply({ ok: true, value }), error => reply(failure(error)));
  return true;
});
