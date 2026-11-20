import {
  escapeHtml, MAX_INLINE_HTML_CHARS, MAX_INLINE_SLOTS, MAX_OPAQUE_TEXT_CHARS,
} from '../shared/inline-html';
import type { InlineAstNode } from '../shared/inline-html';
import { canTranslate, eligible, fieldAllowed, isElement, isSkippedElement, isText } from './surface';

const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'data', 'del', 'dfn', 'em', 'font', 'i', 'ins',
  'mark', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u',
]);
const OPAQUE_INLINE_TAGS = new Set(['code', 'kbd', 'samp']);
const NON_UNIT_ROOTS = new Set([
  'html', 'body', 'select', 'option', 'optgroup', 'textarea', 'svg', 'math',
  'iframe', 'frame', 'script', 'style', 'noscript', 'template', 'head',
]);

export interface InlineSlot {
  id: number;
  element: Element;
  opaque: boolean;
}

export interface InlineUnit {
  root: Element;
  html: string;
  slots: Map<number, InlineSlot>;
  slotIds: Set<number>;
  opaqueIds: Set<number>;
  textNodes: Set<Text>;
  elements: Set<Element>;
}

export interface UnitSnapshot {
  root: Element;
  childrenByParent: Map<Element, ChildNode[]>;
  textByNode: Map<Text, string>;
}

export interface WrittenUnitState {
  childrenByParent: Map<Element, ChildNode[]>;
  textByNode: Map<Text, string>;
}

export function findInlineUnitRoot(node: Node, page: Document): Element | null {
  let current: Node | null = node;
  if (isText(current)) {
    if (current.assignedSlot) return null;
    current = current.parentNode;
  }
  while (current && isElement(current)) {
    if (current.shadowRoot || current.assignedSlot) return null;
    if (!INLINE_TAGS.has(current.localName) && !OPAQUE_INLINE_TAGS.has(current.localName)) {
      if (NON_UNIT_ROOTS.has(current.localName) || !eligible(current, page)) return null;
      return buildInlineUnit(current, page) ? current : null;
    }
    current = current.parentNode;
  }
  return null;
}

export function buildInlineUnit(root: Element, page: Document): InlineUnit | null {
  if (NON_UNIT_ROOTS.has(root.localName) || root.shadowRoot || root.assignedSlot || !eligible(root, page)) {
    return null;
  }

  const slots = new Map<number, InlineSlot>();
  const slotIds = new Set<number>();
  const opaqueIds = new Set<number>();
  const textNodes = new Set<Text>();
  const elements = new Set<Element>();
  let nextId = 0;
  let textCount = 0;
  let translatableTextCount = 0;

  function serializeChildren(parent: Element): string | null {
    let out = '';
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === Node.COMMENT_NODE) return null;
      if (isText(child)) {
        if (!fieldAllowed(child, 'text')) return null;
        textNodes.add(child);
        textCount++;
        if (canTranslate(child.data)) translatableTextCount++;
        out += escapeHtml(child.data);
        continue;
      }
      if (!isElement(child)) return null;
      if (child.shadowRoot || child.assignedSlot || child.hasAttribute('hidden') || child.localName === 'slot') {
        return null;
      }

      const mode = child.getAttribute('translate')?.toLowerCase();
      const explicitNoTranslate = child.classList.contains('notranslate') || mode === 'no';
      const isOpaque = OPAQUE_INLINE_TAGS.has(child.localName) ||
        (INLINE_TAGS.has(child.localName) && explicitNoTranslate);

      if (isOpaque) {
        if (isEditable(child) || child.querySelector('[translate="yes" i], [translate=""], [contenteditable]')) {
          return null;
        }
        const opaqueText = (child.textContent ?? '').trim();
        if (!opaqueText || opaqueText.length > MAX_OPAQUE_TEXT_CHARS || opaqueText.includes('\n')) {
          return null;
        }
        const id = nextId++;
        slots.set(id, { id, element: child, opaque: true });
        slotIds.add(id);
        opaqueIds.add(id);
        elements.add(child);
        out += `<code id="${id}" translate="no">${escapeHtml(opaqueText)}</code>`;
        continue;
      }

      if (INLINE_TAGS.has(child.localName) && !isSkippedElement(child)) {
        const id = nextId++;
        slots.set(id, { id, element: child, opaque: false });
        slotIds.add(id);
        elements.add(child);
        const inner = serializeChildren(child);
        if (inner === null) return null;
        out += `<span id="${id}">${inner}</span>`;
        continue;
      }

      return null;
    }
    return out;
  }

  const html = serializeChildren(root);
  if (html === null) return null;
  if (slots.size < 1 || slots.size > MAX_INLINE_SLOTS) return null;
  if (translatableTextCount < 1 || (textCount < 2 && opaqueIds.size < 1)) return null;
  if (html.length > MAX_INLINE_HTML_CHARS) return null;

  return { root, html, slots, slotIds, opaqueIds, textNodes, elements };
}

export function isInlineFlowVisible(unit: InlineUnit): boolean {
  const view = unit.root.ownerDocument.defaultView;
  if (!view) return false;
  const rootStyle = view.getComputedStyle(unit.root);
  if (rootStyle.visibility !== 'visible') return false;

  const layoutDisplay = rootStyle.display;
  if (layoutDisplay.includes('flex') || layoutDisplay.includes('grid') || layoutDisplay.includes('table')) {
    let hasDirectText = false;
    for (let child = unit.root.firstChild; child; child = child.nextSibling) {
      if (isText(child) && child.data.trim().length > 0) {
        hasDirectText = true;
        break;
      }
    }
    if (!hasDirectText) return false;
  }

  for (const slot of unit.slots.values()) {
    const style = view.getComputedStyle(slot.element);
    if (style.display === 'none' || style.visibility !== 'visible' || style.opacity === '0') {
      return false;
    }
    if (!slot.opaque && style.display !== 'contents' && !style.display.startsWith('inline')) {
      return false;
    }
  }
  return true;
}

export function captureUnitSnapshot(unit: InlineUnit): UnitSnapshot {
  const childrenByParent = new Map<Element, ChildNode[]>();
  childrenByParent.set(unit.root, Array.from(unit.root.childNodes));
  for (const slot of unit.slots.values()) {
    if (!slot.opaque) childrenByParent.set(slot.element, Array.from(slot.element.childNodes));
  }
  const textByNode = new Map<Text, string>();
  for (const text of unit.textNodes) {
    textByNode.set(text, text.data);
  }
  return { root: unit.root, childrenByParent, textByNode };
}

export function applyInlineAst(unit: InlineUnit, ast: readonly InlineAstNode[]): WrittenUnitState {
  const doc = unit.root.ownerDocument;
  const childrenByParent = new Map<Element, ChildNode[]>();
  const textByNode = new Map<Text, string>();
  const usedSlots = new Set<number>();

  function existingTextPool(parent: Element): Text[] {
    const texts: Text[] = [];
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (isText(child)) texts.push(child);
    }
    return texts;
  }

  function reconcile(parent: Element, astNodes: readonly InlineAstNode[]): void {
    const pool = existingTextPool(parent);
    const children: ChildNode[] = [];

    const pushText = (value: string): void => {
      if (!value) return;
      const last = children[children.length - 1];
      if (last && isText(last)) {
        last.data += value;
        textByNode.set(last, last.data);
        return;
      }
      const node = pool.shift() ?? doc.createTextNode('');
      node.data = value;
      textByNode.set(node, value);
      children.push(node);
    };

    const flattenChildren = (nodes: readonly InlineAstNode[]): void => {
      for (const child of nodes) {
        if (child.type === 'text') pushText(child.value);
        else flattenChildren(child.children);
      }
    };

    for (const node of astNodes) {
      if (node.type === 'text') {
        pushText(node.value);
        continue;
      }
      const slot = unit.slots.get(node.id);
      if (!slot || usedSlots.has(node.id)) {
        flattenChildren(node.children);
        continue;
      }
      usedSlots.add(node.id);
      if (!slot.opaque) reconcile(slot.element, node.children);
      children.push(slot.element);
    }

    childrenByParent.set(parent, children);
    if (!childListEquals(parent.childNodes, children)) {
      parent.replaceChildren(...children);
    }
  }

  reconcile(unit.root, ast);
  return { childrenByParent, textByNode };
}

export function restoreUnitSnapshot(snapshot: UnitSnapshot, written: WrittenUnitState): void {
  for (const [parent, origChildren] of snapshot.childrenByParent) {
    const expectedWritten = written.childrenByParent.get(parent);
    if (!expectedWritten) continue;
    if (!childListEquals(parent.childNodes, origChildren) && childListEquals(parent.childNodes, expectedWritten)) {
      parent.replaceChildren(...origChildren);
    }
  }
  for (const [text, origValue] of snapshot.textByNode) {
    const expected = written.textByNode.get(text);
    if (expected === undefined || text.data === expected) {
      text.data = origValue;
    }
  }
}

export function matchesWrittenUnit(written: WrittenUnitState): boolean {
  for (const [parent, expected] of written.childrenByParent) {
    if (!childListEquals(parent.childNodes, expected)) return false;
  }
  for (const [text, expected] of written.textByNode) {
    if (text.data !== expected) return false;
  }
  return true;
}

function childListEquals(actual: NodeListOf<ChildNode>, expected: readonly ChildNode[]): boolean {
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

function isEditable(element: Element): boolean {
  const mode = element.getAttribute('contenteditable')?.toLowerCase();
  return mode === '' || mode === 'true' || mode === 'plaintext-only';
}
