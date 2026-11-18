import { MAX_TRANSLATION_CHARS, OfflineError } from '../shared/offline';
import type { EngineReply, EngineRequest, Pair } from '../shared/offline';
import { Packs } from './packs';
import { Translator } from './translator';

interface Job {
  pair: Pair;
  text: string;
  reply: (result: EngineReply<unknown>) => void;
}

const MAX_QUEUED = 64;
const BATCH_SIZE = 8;
const packs = new Packs();
const translator = new Translator();
const queue: Job[] = [];
let running = false;

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const { pair } = queue[0]!;
      const batch = takeBatch(pair);
      try {
        const route = await packs.route(pair);
        const translations = await translator.translate(route, batch.map(job => job.text));
        batch.forEach((job, index) => {
          const value = translations[index];
          job.reply(value === undefined ? { ok: false, error: 'engine-unavailable' } : { ok: true, value });
        });
      } catch (error) {
        for (const job of batch) job.reply(failure(error));
      }
    }
  } finally {
    running = false;
  }
}

function takeBatch(pair: Pair): Job[] {
  const batch: Job[] = [];
  for (const job of queue) {
    if (job.pair.from !== pair.from || job.pair.to !== pair.to || batch.length === BATCH_SIZE) break;
    batch.push(job);
  }
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
    void drain();
    return true;
  }

  let work: Promise<unknown>;
  if (request.type === 'engine-prepare' && (content || popup)) {
    work = packs.route(request).then(route => translator.prepare(route));
  } else if (request.type === 'packs-state' && (popup || manager)) {
    work = packs.status();
  } else if (request.type === 'packs-install' && manager) {
    work = packs.install(request);
  } else if (request.type === 'packs-remove' && manager) {
    work = packs.remove(request.id);
  } else if (request.type === 'packs-cancel' && manager) {
    packs.cancel();
    reply({ ok: true, value: undefined });
    return;
  } else return;

  void work.then(value => reply({ ok: true, value }), error => reply(failure(error)));
  return true;
});
