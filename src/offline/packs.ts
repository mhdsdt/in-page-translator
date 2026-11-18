import { catalog, packBytes, routeFor } from '../shared/catalog';
import type { Pack } from '../shared/catalog';
import { OfflineError } from '../shared/offline';
import type { DownloadStatus, ModelBuffers, PackStatus, Pair } from '../shared/offline';
import type { DownloadReply, DownloadRequest } from './download-protocol';
import { installedPacks, removePack, writePack } from './store';

interface Download {
  state: DownloadStatus;
  controller: AbortController;
}

export class Packs {
  private installed?: Promise<Set<string>>;
  private active?: Download;
  private removing = false;
  private failure?: PackStatus['failure'];

  async status(): Promise<PackStatus> {
    return {
      installed: [...await this.getInstalled()],
      download: this.active?.state,
      failure: this.failure,
    };
  }

  async route(pair: Pair): Promise<Pack[]> {
    const route = requireRoute(pair);
    const installed = await this.getInstalled();
    if (route.some(pack => !installed.has(pack.id))) throw new OfflineError('missing-packs');
    return route;
  }

  async install(pair: Pair): Promise<void> {
    if (this.active || this.removing) throw new OfflineError('busy');
    const route = requireRoute(pair);
    const installed = await this.getInstalled();
    if (this.active || this.removing) throw new OfflineError('busy');
    const missing = route.filter(pack => !installed.has(pack.id));
    const first = missing[0];
    this.failure = undefined;
    if (!first) return;

    const job: Download = { state: progressFor(first), controller: new AbortController() };
    this.active = job;
    void this.installPacks(missing, installed, job);
  }

  cancel(): void {
    if (this.active && !this.active.state.saving) this.active.controller.abort();
  }

  async remove(id: string): Promise<void> {
    if (this.active || this.removing) throw new OfflineError('busy');
    const pack = catalog.get(id);
    if (!pack) throw new OfflineError('unsupported-pair');
    this.removing = true;
    try {
      const installed = await this.getInstalled();
      await removePack(pack);
      installed.delete(id);
    } catch {
      throw new OfflineError('storage-failed');
    } finally {
      this.removing = false;
    }
  }

  private getInstalled(): Promise<Set<string>> {
    this.installed ??= installedPacks().catch(() => {
      this.installed = undefined;
      throw new OfflineError('storage-failed');
    });
    return this.installed;
  }

  private async installPacks(route: Pack[], installed: Set<string>, job: Download): Promise<void> {
    try {
      for (const pack of route) {
        job.state = progressFor(pack);
        const buffers = await download(pack, job);
        job.controller.signal.throwIfAborted();
        job.state.saving = true;
        await writePack(pack, buffers);
        installed.add(pack.id);
      }
    } catch (error) {
      if (!job.controller.signal.aborted) {
        this.failure = {
          pack: job.state.pack,
          error: job.state.saving ? 'storage-failed'
            : error instanceof OfflineError ? error.code : 'download-failed',
        };
      }
    } finally {
      this.active = undefined;
    }
  }
}

function requireRoute(pair: Pair): Pack[] {
  const route = routeFor(pair.from, pair.to);
  if (!route.length) throw new OfflineError('unsupported-pair');
  return route;
}

function progressFor(pack: Pack): DownloadStatus {
  return { pack: pack.id, received: 0, total: packBytes(pack, 'size'), saving: false };
}

async function download(pack: Pack, job: Download): Promise<ModelBuffers> {
  const { signal } = job.controller;
  signal.throwIfAborted();
  const worker = new Worker('download.js');
  try {
    return await new Promise<ModelBuffers>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      worker.addEventListener('error', () => reject(new Error('Download worker stopped')), { once: true });
      worker.addEventListener('message', ({ data }: MessageEvent<DownloadReply>) => {
        if (data.type === 'progress') job.state.received = data.received;
        else if (data.type === 'complete') resolve(data.buffers);
        else reject(new OfflineError(data.error));
      });
      worker.postMessage({ assets: pack.assets } satisfies DownloadRequest);
    });
  } finally {
    worker.terminate();
  }
}
