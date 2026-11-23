import { catalog, formatSize, packBytes, routeFor } from '../shared/catalog';
import {
  downloadProgressRatio, formatDownloadBytes, formatDownloadFailure, formatDownloadLabel, totalPackBytes,
} from '../shared/format';
import { pairName } from '../shared/languages';
import type { PackStatus } from '../shared/offline';

export interface PacksViewInput {
  from: string;
  to: string;
  state?: PackStatus;
  pending: boolean;
  readFailed: boolean;
  canReturnToPage: boolean;
  notice?: { text: string; error: boolean };
}

export interface RouteStepView {
  id: string;
  label: string;
  installed: boolean;
  sizeText: string;
}

export interface InstalledPackView {
  id: string;
  name: string;
  sizeText: string;
}

export interface PacksView {
  route: RouteStepView[];
  routeSummary: string;
  requirementsText: string;
  ready: boolean;
  installDisabled: boolean;
  installHidden: boolean;
  transferHidden: boolean;
  installBarHidden: boolean;
  cancelDisabled: boolean;
  progressRatio: number;
  transferLabel: string;
  transferBytes: string;
  noticeText: string;
  noticeError: boolean;
  installedEmpty: boolean;
  usageText: string;
  installedList: InstalledPackView[];
  actionsBlocked: boolean;
}

export function derivePacksView(input: PacksViewInput): PacksView {
  const { from, to, state, pending, readFailed, canReturnToPage, notice } = input;
  const routePacks = routeFor(from, to);
  const installedSet = new Set(state?.installed);
  const missing = routePacks.filter(pack => !installedSet.has(pack.id));
  const active = state?.download;
  const actionsBlocked = pending || Boolean(active);
  const installDisabled = actionsBlocked || !state || !missing.length;
  const ready = Boolean(state && routePacks.length && !missing.length);

  const routeSummary = routePacks.length > 1
    ? 'This pair translates through English.'
    : 'Choose the languages you want to translate between.';

  const requirementsText = !routePacks.length
    ? from === to ? 'Choose two different languages.' : 'This language pair is unavailable.'
    : !state ? readFailed ? 'Pack status unavailable.' : 'Checking installed packs…'
    : missing.length ? missing.length + (missing.length === 1 ? ' pack' : ' packs') +
      ' to download · ' + formatSize(totalPackBytes(missing, 'size'))
    : canReturnToPage ? 'Ready offline. Go back to your page and reopen the extension.'
    : 'Ready offline. Open the extension on a web page to translate.';

  const route: RouteStepView[] = routePacks.map(pack => {
    const owned = state ? installedSet.has(pack.id) : false;
    return {
      id: pack.id,
      label: pairName(pack.id),
      installed: owned,
      sizeText: owned ? 'Installed' : state ? formatSize(packBytes(pack, 'size')) : '',
    };
  });

  const ids = [...installedSet]
    .filter(id => catalog.has(id))
    .sort((a, b) => pairName(a).localeCompare(pairName(b), 'en'));

  const usageText = !state
    ? readFailed ? 'Storage status unavailable' : 'Checking storage…'
    : ids.length
      ? ids.length + (ids.length === 1 ? ' pack · ' : ' packs · ') +
        formatSize(ids.reduce((bytes, id) => bytes + packBytes(catalog.get(id)!, 'bytes'), 0)) + ' on disk'
      : '0 MiB on disk';

  const installedList: InstalledPackView[] = ids.map(id => ({
    id,
    name: pairName(id),
    sizeText: formatSize(packBytes(catalog.get(id)!, 'bytes')),
  }));

  let currentNotice = readFailed
    ? { text: 'Couldn’t read installed language packs. Reload the manager to try again.', error: true }
    : notice;
  const failure = state?.failure;
  if (!currentNotice && failure && !state?.download && !pending) {
    currentNotice = { text: formatDownloadFailure(failure), error: true };
  }

  return {
    route,
    routeSummary,
    requirementsText,
    ready,
    installDisabled,
    installHidden: ready,
    transferHidden: !active,
    installBarHidden: Boolean(active),
    cancelDisabled: !active || pending || active.saving,
    progressRatio: active ? downloadProgressRatio(active) : 0,
    transferLabel: active ? formatDownloadLabel(active) : '',
    transferBytes: active && !active.saving ? formatDownloadBytes(active) : '',
    noticeText: currentNotice?.text ?? '',
    noticeError: currentNotice?.error ?? false,
    installedEmpty: Boolean(state) && ids.length === 0,
    usageText,
    installedList,
    actionsBlocked,
  };
}
