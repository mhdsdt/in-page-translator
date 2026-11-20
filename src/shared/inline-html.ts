export const MAX_INLINE_HTML_CHARS = 1_000;
export const MAX_INLINE_SLOTS = 16;
export const MAX_OPAQUE_TEXT_CHARS = 48;

export type InlineAstNode =
  | { type: 'text'; value: string }
  | { type: 'slot'; id: number; children: InlineAstNode[] };

export interface ParsedInlineHtml {
  nodes: InlineAstNode[];
  seenIds: Set<number>;
  duplicateIds: Set<number>;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/gu, ch => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));
}

export function decodeHtmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gu, (match, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff) {
        return String.fromCodePoint(code);
      }
      return match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

interface Frame {
  id: number;
  tag: string;
  children: InlineAstNode[];
}

export function parseInlineHtml(html: string, validIds: ReadonlySet<number>): ParsedInlineHtml {
  const root: InlineAstNode[] = [];
  const stack: Frame[] = [];
  const seenIds = new Set<number>();
  const duplicateIds = new Set<number>();

  const targetList = (): InlineAstNode[] => (stack.length ? stack[stack.length - 1]!.children : root);
  const pushText = (raw: string): void => {
    if (!raw) return;
    const value = decodeHtmlEntities(raw);
    if (!value) return;
    const list = targetList();
    const prev = list[list.length - 1];
    if (prev?.type === 'text') prev.value += value;
    else list.push({ type: 'text', value });
  };

  let cursor = 0;
  while (cursor < html.length) {
    const open = html.indexOf('<', cursor);
    if (open === -1) {
      pushText(html.slice(cursor));
      break;
    }
    if (open > cursor) pushText(html.slice(cursor, open));
    const close = html.indexOf('>', open + 1);
    if (close === -1) {
      pushText(html.slice(open));
      break;
    }

    const inside = html.slice(open + 1, close).trim();
    cursor = close + 1;

    if (!inside) continue;
    if (inside[0] === '/') {
      const closingMatch = inside.slice(1).trim().match(/^([a-zA-Z0-9-]+)/u);
      const tag = closingMatch?.[1]?.toLowerCase();
      if (tag === 'span' || tag === 'code') {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i]!.tag === tag) {
            stack.length = i;
            break;
          }
        }
      }
      continue;
    }

    const selfClosing = inside.endsWith('/');
    const body = selfClosing ? inside.slice(0, -1).trimEnd() : inside;
    const tagMatch = body.match(/^([a-zA-Z0-9-]+)(.*)$/su);
    if (!tagMatch) continue;
    const tag = tagMatch[1]!.toLowerCase();
    const attrs = tagMatch[2] ?? '';

    if (tag !== 'span' && tag !== 'code') continue;
    const idMatch = attrs.match(/(?:^|\s)id\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+)(?=\s|$))/iu);
    const idStr = idMatch?.[1] ?? idMatch?.[2] ?? idMatch?.[3];
    if (idStr === undefined) continue;
    const id = Number.parseInt(idStr, 10);
    if (!validIds.has(id)) continue;

    if (seenIds.has(id)) duplicateIds.add(id);
    else seenIds.add(id);

    const slot: InlineAstNode = { type: 'slot', id, children: [] };
    targetList().push(slot);
    if (!selfClosing) {
      stack.push({ id, tag, children: slot.children });
    }
  }

  return { nodes: root, seenIds, duplicateIds };
}

export function validateInlineTranslation(
  parsed: ParsedInlineHtml,
  expectedIds: ReadonlySet<number>,
  opaqueIds: ReadonlySet<number>,
): boolean {
  for (const id of expectedIds) {
    if (!parsed.seenIds.has(id)) return false;
  }
  for (const id of opaqueIds) {
    if (parsed.duplicateIds.has(id)) return false;
  }
  return true;
}
