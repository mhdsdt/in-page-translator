import assert from 'node:assert/strict';
import test from 'node:test';
import { PatchLedger } from '../../src/page/patches';
import type { InlineUnit } from '../../src/page/inline';

(globalThis as { Node?: unknown }).Node = {
  ELEMENT_NODE: 1,
  TEXT_NODE: 3,
  DOCUMENT_NODE: 9,
  DOCUMENT_FRAGMENT_NODE: 11,
};

interface FakeNode {
  nodeType: number;
  parentNode: FakeElement | null;
  parentElement: FakeElement | null;
  firstChild: FakeNode | null;
  nextSibling: FakeNode | null;
  ownerDocument: FakeDocument;
}

class FakeElement implements FakeNode {
  readonly nodeType = 1;
  parentNode: FakeElement | null = null;
  parentElement: FakeElement | null = null;
  nextSibling: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly ownerDocument: FakeDocument;

  constructor(readonly localName: string, doc: FakeDocument) {
    this.ownerDocument = doc;
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  append(...nodes: FakeNode[]): void {
    this.replaceChildren(...this.childNodes, ...nodes);
  }

  replaceChildren(...nodes: FakeNode[]): void {
    this.childNodes = [...nodes];
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      node.parentNode = this;
      node.parentElement = this;
      node.nextSibling = nodes[index + 1] ?? null;
    }
  }

  closest(selector: string): FakeElement | null {
    for (let current: FakeElement | null = this; current; current = current.parentElement) {
      if (current.localName === selector) return current;
    }
    return null;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
}

class FakeText implements FakeNode {
  readonly nodeType = 3;
  parentNode: FakeElement | null = null;
  parentElement: FakeElement | null = null;
  readonly firstChild = null;
  nextSibling: FakeNode | null = null;

  constructor(public data: string, readonly ownerDocument: FakeDocument) {}
}

class FakeDocument {
  createTextNode(value: string): Text {
    return new FakeText(value, this) as unknown as Text;
  }
}

function makeText(doc: FakeDocument, text: string): Text & FakeText {
  return new FakeText(text, doc) as unknown as Text & FakeText;
}

function makeElement(doc: FakeDocument, tag: string): Element & FakeElement {
  return new FakeElement(tag, doc) as unknown as Element & FakeElement;
}

test('PatchLedger ref-counts RTL dir="auto" across sibling text nodes in a shared container', () => {
  const doc = new FakeDocument();
  const container = makeElement(doc, 'div');
  container.setAttribute('dir', 'ltr');
  const firstSpan = makeElement(doc, 'span');
  const secondSpan = makeElement(doc, 'span');
  const firstText = makeText(doc, 'Hello');
  const secondText = makeText(doc, 'World');
  firstSpan.append(firstText);
  secondSpan.append(secondText);
  container.append(firstSpan, secondSpan);

  const ledger = new PatchLedger(true);
  assert.equal(ledger.beginAttempt(firstText, 'text', 'Hello'), true);
  assert.equal(ledger.beginAttempt(secondText, 'text', 'World'), true);
  ledger.applyTranslation(firstText, 'text', 'Hello', 'مرحبا');
  ledger.applyTranslation(secondText, 'text', 'World', 'بالعالم');
  assert.equal(container.getAttribute('dir'), 'auto');

  ledger.repairNode(firstText, false);
  assert.equal(firstText.data, 'Hello');
  assert.equal(container.getAttribute('dir'), 'auto');

  ledger.repairNode(secondText, false);
  assert.equal(secondText.data, 'World');
  assert.equal(container.getAttribute('dir'), 'ltr');
});

test('PatchLedger releases dir="auto" on forgetField, forgetInlineUnit, and container repair', async () => {
  const doc = new FakeDocument();
  const p = makeElement(doc, 'p');
  const t = makeText(doc, 'Original');
  p.append(t);

  const ledger = new PatchLedger(true);
  ledger.beginAttempt(t, 'text', 'Original');
  ledger.applyTranslation(t, 'text', 'Original', 'مترجم');
  assert.equal(p.getAttribute('dir'), 'auto');

  ledger.forgetField(t, 'text');
  assert.equal(p.getAttribute('dir'), null);

  const link = makeElement(doc, 'a');
  const linkText = makeText(doc, 'guide');
  link.append(linkText);
  const pre = makeText(doc, 'Read ');
  p.replaceChildren(pre, link);

  const unit: InlineUnit = {
    root: p,
    html: 'Read <span id="0">guide</span>',
    slots: new Map([[0, { id: 0, element: link, opaque: false }]]),
    slotIds: new Set([0]),
    opaqueIds: new Set(),
    textNodes: new Set([pre, linkText]),
    elements: new Set([link]),
  };
  assert.equal(ledger.beginInlineAttempt(unit), true);
  ledger.applyInlineTranslation(unit, [
    { type: 'text', value: 'اقرأ ' },
    { type: 'slot', id: 0, children: [{ type: 'text', value: 'الدليل' }] },
  ]);
  assert.equal(p.getAttribute('dir'), 'auto');

  p.setAttribute('dir', 'rtl');
  ledger.forgetInlineUnit(p, true);
  assert.equal(p.getAttribute('dir'), 'rtl');

  p.removeAttribute('dir');
  ledger.beginAttempt(pre, 'text', 'Read ');
  ledger.applyTranslation(pre, 'text', 'Read ', 'اقرأ ');
  assert.equal(p.getAttribute('dir'), 'auto');
  ledger.repairNode(p, false);
  assert.equal(p.getAttribute('dir'), null);

  await ledger.restoreAll(10, async () => {});
  assert.deepEqual(ledger.counts, { seen: 3, updated: 3, failed: 0 });
});

test('PatchLedger maintains seen/updated/failed counters across cancellations and busy retries', () => {
  const doc = new FakeDocument();
  const t1 = makeText(doc, 'One');
  const t2 = makeText(doc, 'Two');
  const ledger = new PatchLedger(false);

  assert.equal(ledger.beginAttempt(t1, 'text', 'One'), true);
  assert.equal(ledger.beginAttempt(t1, 'text', 'One'), false);
  ledger.cancelAttempt(t1, 'text', 'One');
  assert.deepEqual(ledger.counts, { seen: 0, updated: 0, failed: 0 });

  assert.equal(ledger.beginAttempt(t2, 'text', 'Two'), true);
  ledger.recordFailure(t2, 'text', 'Two', true);
  assert.deepEqual(ledger.counts, { seen: 1, updated: 0, failed: 1 });

  assert.equal(ledger.beginAttempt(t2, 'text', 'Two'), true);
  ledger.applyTranslation(t2, 'text', 'Two', 'Deux');
  assert.deepEqual(ledger.counts, { seen: 1, updated: 1, failed: 0 });
});
