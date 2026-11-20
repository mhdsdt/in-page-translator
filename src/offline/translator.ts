import { packKey } from '../shared/catalog';
import type { Pack } from '../shared/catalog';
import { OfflineError } from '../shared/offline';
import type { ModelBuffers } from '../shared/offline';
import { BergamotWorker } from './bergamot';
import { readPack } from './store';

const PRIMARY_IDLE_MS = 180_000;
const BURST_IDLE_MS = 25_000;
const SEED_TTL_MS = 60_000;

interface SeedEntry {
  buffers: ModelBuffers;
  timer: number;
}

class WorkerSlot {
  private worker?: BergamotWorker;
  private init?: Promise<void>;
  private readonly loaded = new Map<string, Pack>();
  private tail = Promise.resolve();
  private idleTimer?: number;
  inFlight = 0;

  constructor(
    private readonly idleMs: number,
    private readonly takeSeed: (pack: Pack) => ModelBuffers | undefined,
  ) {}

  use<T>(route: Pack[], run: (worker: BergamotWorker) => T | Promise<T>): Promise<T> {
    this.inFlight++;
    const result = this.tail.then(async () => {
      window.clearTimeout(this.idleTimer);
      try {
        return await run(await this.ready(route));
      } catch (error) {
        this.retire();
        throw error;
      } finally {
        this.scheduleIdle();
      }
    });
    this.tail = result.then(() => {}, () => {}).finally(() => {
      this.inFlight--;
    });
    return result;
  }

  warmRuntime(): void {
    if (this.worker && !this.worker.closed) return;
    this.retire();
    const worker = new BergamotWorker();
    const init = worker.initialize();
    this.worker = worker;
    this.init = init;
    void init.catch(() => {
      if (this.worker === worker) this.retire();
    });
    this.scheduleIdle();
  }

  evictPack(id: string): void {
    if (!this.loaded.has(id)) return;
    this.tail = this.tail.then(async () => {
      const pack = this.loaded.get(id);
      if (!pack || !this.worker || this.worker.closed) {
        this.loaded.delete(id);
        return;
      }
      try {
        await this.init;
        await this.worker.unloadModel({ from: pack.from, to: pack.to });
      } catch {
        this.retire();
      } finally {
        this.loaded.delete(id);
      }
    });
  }

  private async ready(route: Pack[]): Promise<BergamotWorker> {
    if (this.worker?.closed) this.retire();

    const missing = route.filter(pack => !this.loaded.has(pack.id));
    const files = missing.map(async pack => {
      const buffers = this.takeSeed(pack) ?? await readPack(pack);
      if (!buffers) throw new OfflineError('missing-packs');
      return { pack, buffers };
    });

    const worker = this.worker ?? new BergamotWorker();
    if (!this.worker) {
      this.worker = worker;
      this.init = worker.initialize();
    }
    const [models] = await Promise.all([
      Promise.all(files),
      this.init,
    ]);
    if (worker.closed) throw new Error('Translation worker stopped');

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

  private scheduleIdle(): void {
    window.clearTimeout(this.idleTimer);
    if (this.worker && !this.worker.closed && this.inFlight <= 1) {
      this.idleTimer = window.setTimeout(() => this.retire(), this.idleMs);
    }
  }

  private retire(): void {
    window.clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.worker?.close();
    this.worker = undefined;
    this.init = undefined;
    this.loaded.clear();
  }
}

export class Translator {
  private readonly seeded = new Map<string, SeedEntry>();
  private readonly primary = new WorkerSlot(PRIMARY_IDLE_MS, pack => this.takeSeed(pack));
  private readonly burst = new WorkerSlot(BURST_IDLE_MS, pack => this.takeSeed(pack));

  maxConcurrency(route: Pack[]): number {
    return route.length === 1 && (globalThis.navigator?.hardwareConcurrency ?? 1) >= 4 ? 2 : 1;
  }

  prepare(route: Pack[]): Promise<void> {
    return this.primary.use(route, () => undefined);
  }

  translate(route: Pack[], texts: string[]): Promise<string[]> {
    const slot = this.maxConcurrency(route) > 1 && this.burst.inFlight < this.primary.inFlight
      ? this.burst
      : this.primary;
    return slot.use(route, worker => worker.translate(route.map(({ from, to }) => ({ from, to })), texts));
  }

  // Keep freshly verified buffers briefly in RAM so auto-translation skips an immediate IndexedDB read.
  seedPack(pack: Pack, buffers: ModelBuffers): void {
    const key = packKey(pack);
    this.clearSeed(key);
    const timer = window.setTimeout(() => this.seeded.delete(key), SEED_TTL_MS);
    this.seeded.set(key, { buffers, timer });
  }

  // Start compiling the WASM module ahead of auto-translation while a pack finishes downloading/saving.
  warmRuntime(): void {
    this.primary.warmRuntime();
  }

  evictPack(id: string): void {
    for (const key of this.seeded.keys()) {
      if (key.startsWith(id + '@')) this.clearSeed(key);
    }
    this.primary.evictPack(id);
    this.burst.evictPack(id);
  }

  private takeSeed(pack: Pack): ModelBuffers | undefined {
    const key = packKey(pack);
    const entry = this.seeded.get(key);
    if (!entry) return undefined;
    this.clearSeed(key);
    return entry.buffers;
  }

  private clearSeed(key: string): void {
    const entry = this.seeded.get(key);
    if (!entry) return;
    window.clearTimeout(entry.timer);
    this.seeded.delete(key);
  }
}
