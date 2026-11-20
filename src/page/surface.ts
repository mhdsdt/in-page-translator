import { unquoteCssContent } from '../shared/text';

export const textAttributes = [
  'alt', 'aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext',
  'title', 'placeholder', 'label',
  'data-tooltip', 'data-tip', 'data-original-title', 'data-bs-title', 'data-bs-original-title', 'data-bs-content',
] as const;
export const policyAttributes = ['class', 'hidden', 'contenteditable', 'translate', 'value', 'open'] as const;

type Attribute = typeof textAttributes[number];
export type Field = 'text' | 'value' | Attribute | `data-${string}`;
export type SurfaceRoot = Document | ShadowRoot;
export type Target = Text | Element;

const TEXT_ATTRIBUTE_SET = new Set<string>(textAttributes);

const SKIP_TAGS = new Set([
  'head', 'script', 'style', 'noscript', 'template', 'code', 'pre', 'kbd', 'samp',
]);

export function isElement(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

export function isText(node: Node): node is Text {
  return node.nodeType === Node.TEXT_NODE;
}

export function isSkippedElement(element: Element): boolean {
  if (SKIP_TAGS.has(element.localName)) return true;
  if (element.hasAttribute('hidden') || element.classList.contains('notranslate')) return true;
  const editable = element.getAttribute('contenteditable');
  if (editable !== null) {
    const mode = editable.toLowerCase();
    if (mode === '' || mode === 'true' || mode === 'plaintext-only') return true;
  }
  return false;
}

export function isTranslatableButtonInput(element: Element): boolean {
  if (element.localName !== 'input' || !element.hasAttribute('value')) return false;
  const type = (element.getAttribute('type') ?? 'text').toLowerCase();
  if (type === 'button' || type === 'reset') return true;
  return type === 'submit' && !element.hasAttribute('name');
}

export function optionSelectOwner(node: Target): HTMLSelectElement | null {
  if (isText(node)) return node.parentElement?.closest('option')?.closest('select') ?? null;
  if (isElement(node) && (node.localName === 'option' || node.localName === 'optgroup')) {
    return node.closest('select');
  }
  return null;
}

export function frameDocument(frame: Element): Document | null {
  if (frame.localName !== 'iframe' && frame.localName !== 'frame') return null;
  try {
    return (frame as HTMLIFrameElement).contentDocument;
  } catch {
    return null;
  }
}

export function liveOnPage(node: Node, page: Document): boolean {
  if (!node.isConnected) return false;
  let owner = owningDocument(node);
  while (owner && owner !== page) {
    const frame = owner.defaultView?.frameElement;
    if (!frame || frameDocument(frame) !== owner || !frame.isConnected) return false;
    owner = frame.ownerDocument;
  }
  return owner === page;
}

export function eligible(node: Node, page: Document): boolean {
  if (!liveOnPage(node, page) || owningDocument(node)?.designMode === 'on') return false;
  let translation: boolean | undefined;
  for (let current: Node | null = node; current; current = composedParent(current)) {
    if (!isElement(current)) continue;
    if (isSkippedElement(current)) return false;
    if (translation === undefined) {
      const mode = current.getAttribute('translate')?.toLowerCase();
      if (mode === 'no') translation = false;
      if (mode === '' || mode === 'yes') translation = true;
    }
  }
  return translation !== false;
}

export function composedParent(node: Node): Node | null {
  if (isElement(node) || isText(node)) {
    if (node.assignedSlot) return node.assignedSlot;
  }
  if (node.parentNode) return node.parentNode;
  if (node.nodeType === Node.DOCUMENT_NODE) return (node as Document).defaultView?.frameElement ?? null;
  if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) return (node as ShadowRoot).host ?? null;
  return null;
}

export function composedElementParent(node: Node): Element | null {
  for (let parent = composedParent(node); parent; parent = composedParent(parent)) {
    if (isElement(parent)) return parent;
  }
  return null;
}

function owningDocument(node: Node): Document | null {
  return node.nodeType === Node.DOCUMENT_NODE ? node as Document : node.ownerDocument;
}

export function hasTranslatableDataAttribute(element: Element): boolean {
  if (!element.hasAttributes()) return false;
  for (const attr of element.attributes) {
    if (attr.name.startsWith('data-') && !TEXT_ATTRIBUTE_SET.has(attr.name) && canTranslate(attr.value)) {
      return true;
    }
  }
  return false;
}

export function pseudoContentDataAttributes(element: Element): readonly `data-${string}`[] {
  if (!element.hasAttributes()) return NO_FIELDS;
  const view = element.ownerDocument.defaultView;
  if (!view) return NO_FIELDS;

  const contents: string[] = [];
  for (const pseudo of ['::before', '::after'] as const) {
    const value = unquoteCssContent(view.getComputedStyle(element, pseudo).content);
    if (value) contents.push(value);
  }
  if (!contents.length) return NO_FIELDS;

  const matched: `data-${string}`[] = [];
  for (const attr of element.attributes) {
    if (
      attr.name.startsWith('data-') &&
      !TEXT_ATTRIBUTE_SET.has(attr.name) &&
      canTranslate(attr.value) &&
      contents.includes(attr.value)
    ) {
      matched.push(attr.name as `data-${string}`);
    }
  }
  return matched;
}

export function fieldsOf(node: Node, includePseudo = false): readonly Field[] {
  if (isText(node)) return fieldAllowed(node, 'text') ? TEXT_FIELD : NO_FIELDS;
  if (!isElement(node) || !node.hasAttributes()) return NO_FIELDS;
  const fields: Field[] = textAttributes.filter(attribute => node.hasAttribute(attribute));
  if (isTranslatableButtonInput(node)) fields.push('value');
  if (includePseudo) {
    const pseudo = pseudoContentDataAttributes(node);
    if (pseudo.length) fields.push(...pseudo);
  }
  return fields;
}

export function fieldAllowed(node: Target, field: Field): boolean {
  if (field === 'value') return isElement(node) && isTranslatableButtonInput(node);
  if (field !== 'text') return true;
  if (!isText(node)) return false;
  const parent = node.parentElement;
  if (parent?.closest('textarea')) return false;
  const option = parent?.closest('option');
  if (option && (!option.hasAttribute('value') || !option.closest('select'))) return false;
  return true;
}

const NO_FIELDS = [] as const;
const TEXT_FIELD = ['text'] as const;
const WORD_CHARACTER = /\p{L}/u;
const NON_TRANSLATABLE = /^(?:https?:\/\/|mailto:|www\.)\S+$|^[^\s@]+@[^\s@]+\.[^\s@]+$/iu;

export function readField(node: Target, field: Field): string | null {
  return isText(node) ? node.data : node.getAttribute(field);
}

export function writeField(node: Target, field: Field, value: string): void {
  if (isText(node)) node.data = value;
  else node.setAttribute(field, value);
}

export function canTranslate(value: string): boolean {
  if (!WORD_CHARACTER.test(value)) return false;
  return !NON_TRANSLATABLE.test(value.trim());
}
