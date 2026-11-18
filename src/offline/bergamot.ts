import type { ModelBuffers, Pair } from '../shared/offline';

interface WorkerReply {
  id: number;
  result?: unknown;
  error?: { message: string };
}

interface Translation {
  target: { text: string };
}

export class BergamotWorker {
  private readonly worker = new Worker('bergamot/translator-worker.js');
  private readonly pending = new Map<number, (response: WorkerReply) => void>();
  private sequence = 0;
  private closed = false;

  constructor() {
    this.worker.addEventListener('message', ({ data }: MessageEvent<WorkerReply>) => {
      this.pending.get(data.id)?.(data);
    });
    this.worker.addEventListener('error', () => this.close());
    this.worker.addEventListener('messageerror', () => this.close());
  }

  initialize(): Promise<void> {
    return this.call('initialize', [{ cacheSize: 2_048 }]);
  }

  loadModel(pair: Pair, buffers: ModelBuffers): Promise<void> {
    return this.call('loadTranslationModel', [pair, buffers],
      [buffers.model, buffers.shortlist, ...buffers.vocabs]);
  }

  unloadModel(pair: Pair): Promise<void> {
    return this.call('freeTranslationModel', [pair]);
  }

  async translate(models: Pair[], texts: string[]): Promise<string[]> {
    const result = await this.call<Translation[]>('translate', [{
      models,
      texts: texts.map(text => ({ text, html: false, qualityScores: false })),
    }]);
    return result.map(translation => translation.target.text);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const [id, reply] of this.pending) reply({ id, error: { message: 'Translation worker stopped' } });
  }

  private call<T>(name: string, args: unknown[], transfer: Transferable[] = []): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Translation worker stopped'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const deadline = window.setTimeout(() => this.close(), 15_000);
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
