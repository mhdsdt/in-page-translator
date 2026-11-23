import { MAX_TRANSLATION_CHARS } from './offline';

export const TARGET_CHUNK_CHARS = 800;

const SENTENCE_BREAK = /[\n。！？；.!?;]/u;
const CJK_SENTENCE_BREAK = /[。！？；]/u;

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function* splitText(
  text: string,
  maxChars = MAX_TRANSLATION_CHARS,
  targetChars = TARGET_CHUNK_CHARS,
): Generator<string> {
  if (text.length <= maxChars) {
    if (text.length) yield text;
    return;
  }
  let start = 0;
  while (text.length - start > maxChars) {
    const limit = Math.min(start + maxChars, text.length);
    const target = Math.min(start + targetChars, limit);
    const floor = start + Math.floor(Math.min(targetChars, maxChars) / 2);
    let end = -1;

    for (let candidate = limit - 1; candidate >= floor; candidate--) {
      const char = text.charAt(candidate);
      if (SENTENCE_BREAK.test(char)) {
        const after = candidate + 1;
        if (char === '\n' || CJK_SENTENCE_BREAK.test(char) || after === limit || /\s/u.test(text.charAt(after))) {
          end = after;
          if (candidate <= target) break;
        }
      }
    }
    if (end === -1) {
      for (let candidate = limit; candidate > floor; candidate--) {
        if (/\s/u.test(text.charAt(candidate))) {
          end = candidate;
          break;
        }
      }
    }
    if (end <= start) end = limit;

    if (isLowSurrogate(text.charCodeAt(end)) && end > start + 1) end--;
    yield text.slice(start, end);
    start = end;
  }
  if (start < text.length) yield text.slice(start);
}

export function unquoteCssContent(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length < 2 || trimmed === 'none' || trimmed === 'normal') return null;
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed[trimmed.length - 1] !== quote) return null;

  const inner = trimmed.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === quote) return null;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    if (i + 1 >= inner.length) break;
    const next = inner[++i]!;
    if (next === '\n' || next === '\r' || next === '\f') {
      if (next === '\r' && inner[i + 1] === '\n') i++;
      continue;
    }
    if (/^[0-9a-fA-F]$/u.test(next)) {
      let hex = next;
      while (hex.length < 6 && i + 1 < inner.length && /^[0-9a-fA-F]$/u.test(inner[i + 1]!)) {
        hex += inner[++i]!;
      }
      if (i + 1 < inner.length && /^[ \t\r\n\f]$/u.test(inner[i + 1]!)) {
        if (inner[i + 1] === '\r' && inner[i + 2] === '\n') i += 2;
        else i++;
      }
      const code = Number.parseInt(hex, 16);
      if (code > 0 && code <= 0x10ffff) out += String.fromCodePoint(code);
      continue;
    }
    out += next;
  }
  return out.length ? out : null;
}
