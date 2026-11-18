import type { Pack } from '../shared/catalog';
import { OfflineError } from '../shared/offline';
import { BergamotWorker } from './bergamot';
import { readPack } from './store';

const WARM_IDLE_MS = 120_000;

export class Translator {
  private worker?: BergamotWorker;
  private readonly loaded = new Map<string, Pack>();
  private tail = Promise.resolve();
  private idleTimer?: number;

  prepare(route: Pack[]): Promise<void> {
    return this.use(route, () => undefined);
  }

  translate(route: Pack[], texts: string[]): Promise<string[]> {
    return this.use(route, worker => worker.translate(route.map(({ from, to }) => ({ from, to })), texts));
  }

  private use<T>(route: Pack[], run: (worker: BergamotWorker) => T | Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      window.clearTimeout(this.idleTimer);
      try {
        return await run(await this.ready(route));
      } catch (error) {
        this.retire();
        throw error;
      } finally {
        if (this.worker) this.idleTimer = window.setTimeout(() => this.retire(), WARM_IDLE_MS);
      }
    });
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  private async ready(route: Pack[]): Promise<BergamotWorker> {
    const missing = route.filter(pack => !this.loaded.has(pack.id));
    const files = missing.map(async pack => {
      const buffers = await readPack(pack);
      if (!buffers) throw new OfflineError('missing-packs');
      return { pack, buffers };
    });
    const existing = this.worker;
    const worker = existing ?? new BergamotWorker();
    this.worker = worker;
    const [models] = await Promise.all([
      Promise.all(files),
      existing ? undefined : worker.initialize(),
    ]);
    for (const [id, { from, to }] of this.loaded) {
      if (route.some(pack => pack.id === id)) continue;
      await worker.unloadModel({ from, to });
      this.loaded.delete(id);
    }
    for (const { pack, buffers } of models) {
      await worker.loadModel({ from: pack.from, to: pack.to }, buffers);
      this.loaded.set(pack.id, pack);
    }
    return worker;
  }

  private retire(): void {
    this.worker?.close();
    this.worker = undefined;
    this.loaded.clear();
  }
}
