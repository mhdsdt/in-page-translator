export const textAttributes = ['alt', 'aria-label', 'aria-description', 'title', 'placeholder', 'label'] as const;
export const policyAttributes = ['class', 'hidden', 'contenteditable', 'translate'] as const;

type Attribute = typeof textAttributes[number];
export type Field = 'text' | Attribute;
export type SurfaceRoot = Document | ShadowRoot;
export type Target = Text | Element;

const skipSelector = [
  'head', 'script', 'style', 'noscript', 'template', 'code', 'pre', 'kbd', 'samp',
  '[hidden]', '.notranslate',
  '[contenteditable=""]', '[contenteditable="true" i]', '[contenteditable="plaintext-only" i]',
].join(',');

export function isElement(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

export function isText(node: Node): node is Text {
  return node.nodeType === Node.TEXT_NODE;
}

export function frameDocument(frame: Element): Document | null {
  if (frame.localName !== 'iframe' && frame.localName !== 'frame') return null;
  return (frame as HTMLIFrameElement).contentDocument;
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
    if (current.matches(skipSelector)) return false;
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

export function fieldsOf(node: Node): readonly Field[] {
  if (isText(node)) return fieldAllowed(node, 'text') ? TEXT_FIELD : NO_FIELDS;
  if (!isElement(node) || !node.hasAttributes()) return NO_FIELDS;
  return textAttributes.filter(attribute => node.hasAttribute(attribute));
}

export function fieldAllowed(node: Target, field: Field): boolean {
  return field !== 'text' || (isText(node) && !node.parentElement?.closest('textarea, option'));
}

const NO_FIELDS = [] as const;
const TEXT_FIELD = ['text'] as const;
const WORD_CHARACTER = /\p{L}/u;

export function readField(node: Target, field: Field): string | null {
  return isText(node) ? node.data : node.getAttribute(field);
}

export function writeField(node: Target, field: Field, value: string): void {
  if (isText(node)) node.data = value;
  else node.setAttribute(field, value);
}

export function canTranslate(value: string): boolean {
  if (!WORD_CHARACTER.test(value)) return false;
  return !/^(?:https?:\/\/|mailto:|www\.)\S+$|^[^\s@]+@[^\s@]+\.[^\s@]+$/iu.test(value.trim());
}
