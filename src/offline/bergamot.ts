import type { ModelBuffers, Pair } from '../shared/offline';

interface WorkerReply {
  id: number;
  result?: unknown;
  error?: { message: string };
}

interface Translation {
  target: { text: string };
}

const CACHE_SIZE = 8_192;
const LOAD_TIMEOUT_MS = 30_000;
const TRANSLATE_TIMEOUT_MS = 30_000;
const UNLOAD_TIMEOUT_MS = 10_000;

export class BergamotWorker {
  private readonly worker = new Worker('bergamot/translator-worker.js');
  private readonly pending = new Map<number, (response: WorkerReply) => void>();
  private sequence = 0;
  private isClosed = false;

  constructor() {
    this.worker.addEventListener('message', ({ data }: MessageEvent<WorkerReply>) => {
      this.pending.get(data.id)?.(data);
    });
    this.worker.addEventListener('error', () => this.close());
    this.worker.addEventListener('messageerror', () => this.close());
  }

  get closed(): boolean {
    return this.isClosed;
  }

  initialize(): Promise<void> {
    return this.call('initialize', [{ cacheSize: CACHE_SIZE }], [], LOAD_TIMEOUT_MS);
  }

  loadModel(pair: Pair, buffers: ModelBuffers): Promise<void> {
    return this.call(
      'loadTranslationModel',
      [pair, buffers],
      [buffers.model, buffers.shortlist, ...buffers.vocabs],
      LOAD_TIMEOUT_MS,
    );
  }

  unloadModel(pair: Pair): Promise<void> {
    return this.call('freeTranslationModel', [pair], [], UNLOAD_TIMEOUT_MS);
  }

  async translate(models: Pair[], texts: string[]): Promise<string[]> {
    const result = await this.call<Translation[]>('translate', [{
      models,
      texts: texts.map(text => ({ text, html: false, qualityScores: false })),
    }], [], TRANSLATE_TIMEOUT_MS);
    return result.map(translation => translation.target.text);
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.worker.terminate();
    for (const [id, reply] of this.pending) reply({ id, error: { message: 'Translation worker stopped' } });
  }

  private call<T>(
    name: string,
    args: unknown[],
    transfer: Transferable[],
    timeoutMs: number,
  ): Promise<T> {
    if (this.isClosed) return Promise.reject(new Error('Translation worker stopped'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const deadline = window.setTimeout(() => this.close(), timeoutMs);
      this.pending.set(id, response => {
        window.clearTimeout(deadline);
        this.pending.delete(id);
        if (response.error) reject(new Error(response.error.message));
        else resolve(response.result as T);
      });
      try {
        this.worker.postMessage({ id, name, args }, transfer);
      } catch {
        this.close();
      }
    });
  }
}
