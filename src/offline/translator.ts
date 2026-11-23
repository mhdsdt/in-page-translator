import { packKey } from '../shared/catalog';
import type { Pack } from '../shared/catalog';
import { OfflineError } from '../shared/offline';
import type { ModelBuffers, TranslateItem } from '../shared/offline';
import { BergamotWorker } from './bergamot';
import { readPack } from './store';

const PRIMARY_IDLE_MS = 180_000;
const BURST_IDLE_MS = 45_000;
const BUFFER_TTL_MS = 60_000;

interface CachedBuffers {
  buffers: ModelBuffers;
  timer: number;
}

function poolLimit(): number {
  const cores = globalThis.navigator?.hardwareConcurrency ?? 1;
  if (cores >= 8) return 4;
  if (cores >= 4) return 3;
  if (cores >= 2) return 2;
  return 1;
}

function routeKey(route: readonly Pack[]): string {
  return route.map(pack => pack.id).join('>');
}

function cloneBuffers(buffers: ModelBuffers): ModelBuffers {
  return {
    model: buffers.model.slice(0),
    shortlist: buffers.shortlist.slice(0),
    vocabs: buffers.vocabs.map(vocab => vocab.slice(0)),
  };
}

class WorkerSlot {
  private worker?: BergamotWorker;
  private init?: Promise<void>;
  private readonly loaded = new Map<string, Pack>();
  private tail = Promise.resolve();
  private idleTimer?: number;
  private activeRouteKey: string | undefined;
  inFlight = 0;

  constructor(
    private readonly idleMs: number,
    private readonly acquire: (pack: Pack) => Promise<ModelBuffers | undefined>,
  ) {}

  hasRoute(route: readonly Pack[]): boolean {
    return Boolean(
      this.worker && !this.worker.closed &&
      this.loaded.size === route.length &&
      route.every(pack => this.loaded.has(pack.id)),
    );
  }

  isIdle(): boolean {
    return this.inFlight === 0;
  }

  isReadyFor(route: readonly Pack[]): boolean {
    return this.inFlight === 0 && this.hasRoute(route);
  }

  isWorkingOn(key: string): boolean {
    return this.inFlight > 0 && this.activeRouteKey === key;
  }

  use<T>(route: Pack[], run: (worker: BergamotWorker) => T | Promise<T>): Promise<T> {
    this.inFlight++;
    const key = routeKey(route);
    if (this.inFlight === 1) this.activeRouteKey = key;
    const result = this.tail.then(async () => {
      window.clearTimeout(this.idleTimer);
      this.activeRouteKey = key;
      try {
        return await run(await this.ready(route));
      } catch (error) {
        this.retire();
        throw error;
      } finally {
        this.inFlight--;
        if (this.inFlight === 0) this.activeRouteKey = undefined;
        this.scheduleIdle();
      }
    });
    this.tail = result.then(() => {}, () => {});
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
      const buffers = await this.acquire(pack);
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
    if (this.worker && !this.worker.closed && this.inFlight === 0) {
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
  private readonly packBuffers = new Map<string, CachedBuffers>();
  private readonly pendingReads = new Map<string, Promise<ModelBuffers | undefined>>();
  private readonly slots: WorkerSlot[];

  constructor() {
    const count = poolLimit();
    this.slots = Array.from({ length: count }, (_, index) =>
      new WorkerSlot(index === 0 ? PRIMARY_IDLE_MS : BURST_IDLE_MS, pack => this.acquireBuffers(pack)),
    );
  }

  maxConcurrency(route: readonly Pack[]): number {
    const count = this.slots.length;
    if (route.length === 1) return count;
    return count >= 3 ? 2 : 1;
  }

  prepare(route: Pack[]): Promise<void> {
    const primaryReady = this.slots[0]!.use(route, () => undefined);
    if (this.maxConcurrency(route) >= 2) {
      void primaryReady.then(() => {
        const second = this.slots[1];
        if (second && second.isIdle() && !second.hasRoute(route)) {
          void second.use(route, () => undefined).catch(() => {});
        }
      }, () => {});
    }
    return primaryReady;
  }

  acquireReadySlot(route: Pack[]): number | undefined {
    const limit = this.maxConcurrency(route);
    for (let index = 0; index < limit; index++) {
      if (this.slots[index]!.isReadyFor(route)) return index;
    }
    const key = routeKey(route);
    for (let index = 0; index < limit; index++) {
      const slot = this.slots[index]!;
      if (slot.hasRoute(route) || slot.isWorkingOn(key)) return undefined;
    }
    for (let index = 0; index < limit; index++) {
      if (this.slots[index]!.isIdle()) return index;
    }
    return undefined;
  }

  warmExtra(route: Pack[], desiredTotal: number, onReady: () => void): void {
    const limit = Math.min(desiredTotal, this.maxConcurrency(route));
    const key = routeKey(route);
    let covered = 0;
    for (let index = 0; index < limit; index++) {
      const slot = this.slots[index]!;
      if (slot.hasRoute(route) || slot.isWorkingOn(key)) covered++;
    }
    if (covered >= limit) return;
    for (let index = 0; index < limit && covered < limit; index++) {
      const slot = this.slots[index]!;
      if (!slot.isIdle() || slot.hasRoute(route)) continue;
      covered++;
      void slot.use(route, () => undefined).then(() => onReady(), () => {});
    }
  }

  translateOn(slotIndex: number, route: Pack[], items: TranslateItem[]): Promise<string[]> {
    const slot = this.slots[slotIndex] ?? this.slots[0]!;
    const models = route.map(({ from, to }) => ({ from, to }));
    return slot.use(route, worker => worker.translate(models, items));
  }

  translate(route: Pack[], items: TranslateItem[]): Promise<string[]> {
    const slotIndex = this.acquireReadySlot(route) ?? 0;
    return this.translateOn(slotIndex, route, items);
  }

  seedPack(pack: Pack, buffers: ModelBuffers): void {
    this.cacheBuffers(packKey(pack), buffers);
  }

  warmRuntime(): void {
    this.slots[0]?.warmRuntime();
  }

  evictPack(id: string): void {
    for (const key of this.packBuffers.keys()) {
      if (key.startsWith(id + '@')) this.clearBuffers(key);
    }
    for (const slot of this.slots) slot.evictPack(id);
  }

  private async acquireBuffers(pack: Pack): Promise<ModelBuffers | undefined> {
    const key = packKey(pack);
    const cached = this.packBuffers.get(key);
    if (cached) {
      this.refreshBufferTimer(key, cached);
      return cloneBuffers(cached.buffers);
    }

    let reading = this.pendingReads.get(key);
    if (!reading) {
      reading = readPack(pack).then(buffers => {
        if (buffers) this.cacheBuffers(key, buffers);
        return buffers;
      }).finally(() => {
        this.pendingReads.delete(key);
      });
      this.pendingReads.set(key, reading);
    }

    const buffers = await reading;
    return buffers ? cloneBuffers(buffers) : undefined;
  }

  private cacheBuffers(key: string, buffers: ModelBuffers): void {
    this.clearBuffers(key);
    const timer = window.setTimeout(() => this.packBuffers.delete(key), BUFFER_TTL_MS);
    this.packBuffers.set(key, { buffers, timer });
  }

  private refreshBufferTimer(key: string, entry: CachedBuffers): void {
    window.clearTimeout(entry.timer);
    entry.timer = window.setTimeout(() => this.packBuffers.delete(key), BUFFER_TTL_MS);
  }

  private clearBuffers(key: string): void {
    const entry = this.packBuffers.get(key);
    if (!entry) return;
    window.clearTimeout(entry.timer);
    this.packBuffers.delete(key);
  }
}
