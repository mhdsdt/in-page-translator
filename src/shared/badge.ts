import type { DownloadStatus } from './offline';
import type { PageState } from './protocol';

export interface BadgeSpec {
  text: string;
  color: string;
}

const EMPTY_BADGE: BadgeSpec = { text: '', color: '' };
const BUSY_COLOR = '#355245';
const SUCCESS_COLOR = '#236544';
const WARN_COLOR = '#805015';
const ERROR_COLOR = '#a13629';

export function downloadProgressRatio(active: DownloadStatus): number {
  if (active.saving) return 1;
  return active.total ? Math.min(1, Math.max(0, active.received / active.total)) : 0;
}

export function badgeForPage(state: PageState): BadgeSpec {
  switch (state.phase) {
    case 'translated':
      if (state.failed > 0 || state.error === 'no-text') return { text: '!', color: WARN_COLOR };
      return {
        text: (state.target ?? '').split('-')[0]?.slice(0, 2).toUpperCase() || 'OK',
        color: SUCCESS_COLOR,
      };
    case 'preparing':
    case 'translating':
      return { text: '…', color: BUSY_COLOR };
    case 'error':
      return { text: '!', color: ERROR_COLOR };
    case 'original':
    case 'restoring':
      return EMPTY_BADGE;
  }
}

export function badgeForDownload(active: DownloadStatus): BadgeSpec {
  if (active.saving) return { text: '…', color: BUSY_COLOR };
  const pct = Math.min(99, Math.max(0, Math.floor(downloadProgressRatio(active) * 100)));
  return { text: pct + '%', color: BUSY_COLOR };
}
