import { engineRequest, MAX_TRANSLATION_CHARS, OfflineError, requestEngine } from '../shared/offline';
import type { Pair } from '../shared/offline';

interface TranslatorInstance {
  translate(text: string, options: { signal: AbortSignal }): Promise<string>;
}

export async function openEngine(pair: Pair, signal: AbortSignal): Promise<TranslatorInstance> {
  await engineRequest({ type: 'engine-prepare', ...pair });
  signal.throwIfAborted();
  return {
    async translate(text, { signal }) {
      for (const delay of [50, 150, 450]) {
        signal.throwIfAborted();
        try {
          return await requestEngine({ type: 'engine-translate', ...pair, text });
        } catch (error) {
          if (!(error instanceof OfflineError) || error.code !== 'busy') throw error;
          await new Promise(resolve => window.setTimeout(resolve, delay));
        }
      }
      signal.throwIfAborted();
      return requestEngine({ type: 'engine-translate', ...pair, text });
    },
  };
}

const CACHE_ENTRIES = 512;

// Reuse in-flight and completed translations of repeated text.
export class TranslationCache {
  private readonly entries = new Map<string, Promise<string>>();

  constructor(
    private readonly translator: TranslatorInstance,
    private readonly signal: AbortSignal,
  ) {}

  async translate(text: string): Promise<string> {
    let translated = '';
    for (const part of splitText(text)) {
      this.signal.throwIfAborted();
      const core = part.trim();
      if (!core) {
        translated += part;
        continue;
      }
      const leading = part.length - part.trimStart().length;
      const trailing = part.length - part.trimEnd().length;
      translated += part.slice(0, leading) + await this.lookup(core) + part.slice(part.length - trailing);
    }
    return translated;
  }

  private lookup(text: string): Promise<string> {
    const present = this.entries.get(text);
    if (present) {
      this.entries.delete(text);
      this.entries.set(text, present);
      return present;
    }
    const pending = this.translator.translate(text, { signal: this.signal })
      .then(result => result.trim() || text)
      .catch((error: unknown) => {
        if (this.entries.get(text) === pending) this.entries.delete(text);
        throw error;
      });

    this.entries.set(text, pending);
    if (this.entries.size > CACHE_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    return pending;
  }
}

function* splitText(text: string): Generator<string> {
  let start = 0;
  while (text.length - start > MAX_TRANSLATION_CHARS) {
    const limit = start + MAX_TRANSLATION_CHARS;
    let end = limit;
    for (let candidate = limit; candidate > start + MAX_TRANSLATION_CHARS / 2; candidate--) {
      if (/\s/u.test(text.charAt(candidate))) {
        end = candidate;
        break;
      }
    }
    // Keep a UTF-16 surrogate pair together when a long input has no word boundary.
    const code = text.charCodeAt(end);
    if (code >= 0xdc00 && code <= 0xdfff) end--;
    yield text.slice(start, end);
    start = end;
  }
  if (start < text.length) yield text.slice(start);
}
