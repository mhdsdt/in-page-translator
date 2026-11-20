import { formatSize, packBytes } from './catalog';
import type { Pack } from './catalog';
import { pairName } from './languages';
import type { DownloadStatus, PackStatus } from './offline';

export function formatDownloadFailure(failure: NonNullable<PackStatus['failure']>): string {
  const pair = pairName(failure.pack);
  if (failure.error === 'storage-failed') {
    return 'Couldn’t save ' + pair + '. Check available storage and try again.';
  }
  if (failure.error === 'integrity-failed') {
    return 'The ' + pair + ' download did not pass verification. Try again.';
  }
  return 'Couldn’t download ' + pair + '. Check the connection and try again.';
}

export function formatDownloadLabel(active: DownloadStatus, ellipsis = false): string {
  const stepLabel = active.steps > 1 ? ' (' + active.step + ' of ' + active.steps + ')' : '';
  const verb = active.saving ? 'Saving ' : 'Downloading ';
  return verb + pairName(active.pack) + stepLabel + (ellipsis || active.saving ? '…' : '');
}

export function downloadProgressRatio(active: DownloadStatus): number {
  if (active.saving) return 1;
  return active.total ? Math.min(1, Math.max(0, active.received / active.total)) : 0;
}

export function formatDownloadBytes(active: DownloadStatus): string {
  const ratio = downloadProgressRatio(active);
  return formatSize(active.received) + ' of ' + formatSize(active.total) + ' · ' + Math.floor(ratio * 100) + '%';
}

export function totalPackBytes(packs: readonly Pack[], field: 'size' | 'bytes'): number {
  return packs.reduce((bytes, pack) => bytes + packBytes(pack, field), 0);
}
