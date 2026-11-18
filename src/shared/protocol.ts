export type PageError =
  | 'language-unknown' | 'same-language' | 'unsupported-pair' | 'missing-packs'
  | 'engine-unavailable' | 'no-text' | 'translation-failed';

export type Phase = 'original' | 'preparing' | 'translating' | 'translated' | 'restoring' | 'error';

export interface PageState {
  phase: Phase;
  declared?: string;
  source?: string;
  target?: string;
  updated: number;
  failed: number;
  error?: PageError;
}

export type PageRequest =
  | { type: 'status' }
  | { type: 'start'; source?: string; target: string }
  | { type: 'restore' };

export interface PackSelection {
  documentId: string;
  source: string;
  target: string;
}

export function packSelectionKey(tabId: number): string {
  return 'packSelection:' + tabId;
}
