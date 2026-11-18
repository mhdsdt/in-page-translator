import type { Pack } from '../shared/catalog';
import type { ModelBuffers, PackError } from '../shared/offline';

export type DownloadRequest = Pick<Pack, 'assets'>;
export type DownloadReply =
  | { type: 'progress'; received: number }
  | { type: 'complete'; buffers: ModelBuffers }
  | { type: 'failed'; error: PackError };
