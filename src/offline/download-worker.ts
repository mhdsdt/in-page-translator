import source from '../shared/model-source.json' with { type: 'json' };
import { OfflineError } from '../shared/offline';
import type { PackAsset } from '../shared/catalog';
import type { DownloadReply, DownloadRequest } from './download-protocol';

const worker = globalThis as unknown as {
  onmessage: (event: MessageEvent<DownloadRequest>) => void;
  postMessage(reply: DownloadReply, transfer?: Transferable[]): void;
};

worker.onmessage = ({ data }) => {
  void download(data).catch(error => worker.postMessage({
    type: 'failed', error: error instanceof OfflineError ? error.code : 'download-failed',
  }));
};

async function download({ assets }: DownloadRequest): Promise<void> {
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  function resetDeadline(): void {
    clearTimeout(deadline);
    deadline = setTimeout(() => controller.abort(), 45_000);
  }
  resetDeadline();
  let received = 0;
  let reported = 0;
  try {
    const [model, shortlist, ...vocabs] = await Promise.all(assets.map(asset =>
      fetchAsset(asset, controller.signal, bytes => {
        received += bytes;
        if (received - reported < 128 * 1024) return;
        reported = received;
        resetDeadline();
        worker.postMessage({ type: 'progress', received });
      }),
    ));
    if (!model || !shortlist || !vocabs.length) throw new Error('Incomplete model pack');
    worker.postMessage({ type: 'complete', buffers: { model, shortlist, vocabs } },
      [model, shortlist, ...vocabs]);
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
}

async function fetchAsset(asset: PackAsset, signal: AbortSignal, progress: (bytes: number) => void): Promise<ArrayBuffer> {
  const response = await fetch(source + asset.file, {
    signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
  });
  if (!response.ok || !response.body) throw new Error('Model asset unavailable (HTTP ' + response.status + ')');

  let received = 0;
  const transfer = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, stream) {
      received += chunk.length;
      if (received > asset.size) throw new OfflineError('integrity-failed');
      progress(chunk.length);
      stream.enqueue(chunk);
    },
  });
  const reader = response.body.pipeThrough(transfer).pipeThrough(new DecompressionStream('gzip')).getReader();
  const unpacked = new Uint8Array(asset.bytes);
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > unpacked.length) throw new OfflineError('integrity-failed');
      unpacked.set(value, offset);
      offset += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (received !== asset.size || offset !== asset.bytes || await hash(unpacked) !== asset.unpacked) {
    throw new OfflineError('integrity-failed');
  }
  return unpacked.buffer;
}

async function hash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
