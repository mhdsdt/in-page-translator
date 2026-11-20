import { isRtlLanguage, normalizeLanguage } from '../shared/languages';
import { OfflineError } from '../shared/offline';
import type { PageError, PageEvent, PageRequest, PageState } from '../shared/protocol';
import { openEngine, TranslationCache } from './engine';
import { PageSession } from './session';

const SETUP_TIMEOUT_MS = 30_000;

interface ActiveRun {
  controller: AbortController;
  session?: PageSession;
}

const scope = globalThis as typeof globalThis & { inPageTranslatorInstalled?: boolean };

if (!scope.inPageTranslatorInstalled) {
  scope.inPageTranslatorInstalled = true;
  install();
}

function install(): void {
  let state: PageState = { phase: 'original', updated: 0, failed: 0 };
  let active: ActiveRun | undefined;

  const declared = () => normalizeLanguage(document.documentElement?.lang);
  const snapshot = (): PageState => ({ ...state, declared: declared() });
  const notify = () => {
    const event: PageEvent = { type: 'page-state', state: snapshot() };
    void chrome.runtime.sendMessage(event).catch(() => {});
  };

  async function start(source: string | undefined, target: string): Promise<void> {
    if (active || state.phase === 'restoring') return;
    state = { phase: 'error', source, target, updated: 0, failed: 0 };
    if (!source || source === target) {
      state.error = source ? 'same-language' : 'language-unknown';
      notify();
      return;
    }

    const controller = new AbortController();
    const run: ActiveRun = { controller };
    active = run;
    const { signal } = controller;
    state = { ...state, phase: 'preparing' };
    notify();

    function fail(error: PageError): void {
      if (active !== run) return;
      active = undefined;
      controller.abort();
      state = { phase: 'error', source, target, updated: 0, failed: 0, error };
      notify();
    }

    const watchdog = window.setTimeout(() => fail('engine-unavailable'), SETUP_TIMEOUT_MS);
    signal.addEventListener('abort', () => window.clearTimeout(watchdog), { once: true });
    try {
      const engine = await openEngine({ from: source, to: target }, signal);
      if (signal.aborted) return;
      state = { phase: 'translating', source, target, updated: 0, failed: 0 };
      notify();
      run.session = new PageSession(
        document,
        new TranslationCache(engine, signal),
        signal,
        (counts, idle) => {
          if (active !== run) return;
          state.updated = counts.updated;
          state.failed = counts.failed;
          if (idle) {
            state.phase = 'translated';
            state.error = counts.seen === 0 ? 'no-text'
              : counts.seen === counts.failed ? 'translation-failed' : undefined;
          } else if (counts.seen) {
            state.error = undefined;
          }
          notify();
        },
        isRtlLanguage(target),
      );
      run.session.start();
    } catch (error) {
      fail(error instanceof OfflineError && (error.code === 'missing-packs' || error.code === 'unsupported-pair')
        ? error.code : 'engine-unavailable');
    } finally {
      window.clearTimeout(watchdog);
    }
  }

  async function restore(): Promise<void> {
    if (state.phase === 'restoring') return;
    const previous = active;
    active = undefined;
    previous?.controller.abort();
    state.phase = 'restoring';
    notify();
    await previous?.session?.restore();
    state = { phase: 'original', updated: 0, failed: 0 };
    notify();
  }

  chrome.runtime.onMessage.addListener((request: PageRequest, sender, reply) => {
    // Accept only extension-owned contexts (popup and background service worker), never content scripts.
    if (sender.id !== chrome.runtime.id || sender.tab) return;
    if (request.type === 'start') {
      void start(request.source, request.target);
    } else if (request.type === 'restore') {
      void restore();
    } else if (request.type !== 'status') return;
    reply(snapshot());
  });
}
