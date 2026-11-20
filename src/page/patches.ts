import type { InlineAstNode } from '../shared/inline-html';
import {
  applyInlineAst, captureUnitSnapshot, matchesWrittenUnit, restoreUnitSnapshot,
} from './inline';
import type { InlineUnit, UnitSnapshot, WrittenUnitState } from './inline';
import { canTranslate, fieldAllowed, isElement, isText, readField, writeField } from './surface';
import type { Field, Target } from './surface';

export interface Patch {
  original: string;
  written: string;
}

export interface Counts {
  seen: number;
  updated: number;
  failed: number;
}

export interface InlineUnitRecord {
  unit: InlineUnit;
  attemptedHtml?: string;
  busy: boolean;
  snapshot?: UnitSnapshot;
  written?: WrittenUnitState;
}

const DIR_CONTAINERS = new Set([
  'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'dd', 'dt', 'td', 'th',
  'figcaption', 'caption', 'summary', 'div', 'article', 'section', 'main', 'aside',
  'header', 'footer', 'label', 'button', 'select',
]);

// Tracks translated DOM fields, inline HTML sentence units, RTL direction overrides, and restoration.
export class PatchLedger {
  private readonly patches = new Map<Target, Map<Field, Patch>>();
  private readonly inlineUnits = new Map<Element, InlineUnitRecord>();
  private readonly nodeToUnit = new WeakMap<Node, Element>();
  private readonly dirPatches = new Map<Element, string | null>();
  private readonly attempted = new WeakMap<Target, Map<Field, string>>();
  private readonly busy = new WeakMap<Target, Set<Field>>();
  readonly counts: Counts = { seen: 0, updated: 0, failed: 0 };

  constructor(private readonly targetRtl = false) {}

  original(node: Target, field: Field): string | undefined {
    const value = readField(node, field);
    if (value !== null &&
      this.attempted.get(node)?.get(field) !== value &&
      this.patches.get(node)?.get(field)?.written !== value &&
      canTranslate(value)) {
      return value;
    }
  }

  isOwnWrite(node: Target, field: Field): boolean {
    const patch = this.patches.get(node)?.get(field);
    return Boolean(patch && readField(node, field) === patch.written);
  }

  forgetField(node: Target, field: Field): void {
    this.attempted.get(node)?.delete(field);
    this.clearBusy(node, field);
    const fields = this.patches.get(node);
    if (fields) {
      fields.delete(field);
      if (!fields.size) this.patches.delete(node);
    }
  }

  beginAttempt(node: Target, field: Field, original: string): boolean {
    if (this.attempted.get(node)?.get(field) === original) return false;
    let attempts = this.attempted.get(node);
    if (!attempts) {
      attempts = new Map();
      this.attempted.set(node, attempts);
    }
    attempts.set(field, original);
    this.clearBusy(node, field);
    this.counts.seen++;
    return true;
  }

  cancelAttempt(node: Target, field: Field, original: string): void {
    const attempts = this.attempted.get(node);
    if (attempts?.get(field) === original) attempts.delete(field);
    this.counts.seen--;
  }

  recordFailure(node: Target, field: Field, original: string, retryAfterExit: boolean): void {
    this.counts.failed++;
    if (!retryAfterExit) return;
    const attempts = this.attempted.get(node);
    if (attempts?.get(field) === original) attempts.delete(field);
    let deferred = this.busy.get(node);
    if (!deferred) {
      deferred = new Set();
      this.busy.set(node, deferred);
    }
    deferred.add(field);
  }

  applyTranslation(node: Target, field: Field, original: string, written: string): void {
    if (original === written) return;
    let fields = this.patches.get(node);
    if (!fields) {
      fields = new Map();
      this.patches.set(node, fields);
    }
    fields.set(field, { original, written });
    writeField(node, field, written);
    this.counts.updated++;

    if (this.targetRtl && field === 'text') {
      const container = dirContainer(node);
      if (container) this.applyRtlDir(container);
    }
  }

  hasUnit(root: Element): boolean {
    return this.inlineUnits.has(root);
  }

  unitFor(node: Node): InlineUnitRecord | undefined {
    const root = this.nodeToUnit.get(node);
    return root ? this.inlineUnits.get(root) : undefined;
  }

  isOwnInlineMutation(target: Node): boolean {
    const record = this.unitFor(target);
    return Boolean(record?.written && matchesWrittenUnit(record.written));
  }

  beginInlineAttempt(unit: InlineUnit): boolean {
    const existing = this.inlineUnits.get(unit.root);
    if (existing?.attemptedHtml === unit.html) return false;
    if (existing?.busy) this.clearInlineBusy(existing);
    this.inlineUnits.set(unit.root, { unit, attemptedHtml: unit.html, busy: false });
    this.counts.seen++;
    return true;
  }

  cancelInlineAttempt(root: Element, html: string): void {
    const record = this.inlineUnits.get(root);
    if (!record || record.attemptedHtml !== html) return;
    this.inlineUnits.delete(root);
    this.counts.seen--;
  }

  recordInlineFailure(root: Element, html: string, retryAfterExit: boolean): void {
    const record = this.inlineUnits.get(root);
    this.counts.failed++;
    if (!retryAfterExit || !record || record.attemptedHtml !== html) return;
    record.attemptedHtml = undefined;
    record.busy = true;
  }

  applyInlineTranslation(unit: InlineUnit, ast: readonly InlineAstNode[]): void {
    const record = this.inlineUnits.get(unit.root);
    if (!record) return;
    const snapshot = captureUnitSnapshot(unit);
    const written = applyInlineAst(unit, ast);
    record.snapshot = snapshot;
    record.written = written;
    this.registerUnitNodes(unit, written);
    this.counts.updated++;
    if (this.targetRtl) this.applyRtlDir(unit.root);
  }

  forgetInlineUnit(root: Element, restore: boolean): void {
    const record = this.inlineUnits.get(root);
    if (!record) return;
    if (record.busy) this.clearInlineBusy(record);
    if (restore && record.snapshot && record.written) {
      restoreUnitSnapshot(record.snapshot, record.written);
    }
    this.inlineUnits.delete(root);
    if (restore && this.dirPatches.has(root)) {
      restoreDir(root, this.dirPatches.get(root) ?? null);
      this.dirPatches.delete(root);
    }
  }

  repairNode(node: Target, allowed: boolean): void {
    const fields = this.patches.get(node);
    if (fields) {
      for (const [field, patch] of fields) {
        if (allowed && fieldAllowed(node, field)) continue;
        this.undo(node, field, patch);
        fields.delete(field);
        this.attempted.get(node)?.delete(field);
      }
      if (!fields.size) this.patches.delete(node);
    }
    if (!allowed) {
      this.attempted.delete(node);
      for (const field of this.busy.get(node) ?? []) this.clearBusy(node, field);
      const unitRecord = this.unitFor(node);
      if (unitRecord) {
        this.forgetInlineUnit(unitRecord.unit.root, true);
      }
      if (isElement(node) && this.dirPatches.has(node)) {
        restoreDir(node, this.dirPatches.get(node) ?? null);
        this.dirPatches.delete(node);
      }
    }
  }

  async restoreAll(sliceMs: number, yieldToPage: () => Promise<void>): Promise<void> {
    let deadline = performance.now() + sliceMs;
    for (const [node, fields] of this.patches) {
      for (const [field, patch] of fields) this.undo(node, field, patch);
      if (performance.now() >= deadline) {
        await yieldToPage();
        deadline = performance.now() + sliceMs;
      }
    }
    this.patches.clear();

    for (const record of this.inlineUnits.values()) {
      if (record.snapshot && record.written) {
        restoreUnitSnapshot(record.snapshot, record.written);
      }
      if (performance.now() >= deadline) {
        await yieldToPage();
        deadline = performance.now() + sliceMs;
      }
    }
    this.inlineUnits.clear();

    for (const [element, previous] of this.dirPatches) {
      restoreDir(element, previous);
    }
    this.dirPatches.clear();
  }

  private applyRtlDir(container: Element): void {
    if (this.dirPatches.has(container)) return;
    this.dirPatches.set(container, container.getAttribute('dir'));
    container.setAttribute('dir', 'auto');
  }

  private registerUnitNodes(unit: InlineUnit, written: WrittenUnitState): void {
    this.nodeToUnit.set(unit.root, unit.root);
    for (const element of unit.elements) this.nodeToUnit.set(element, unit.root);
    for (const text of unit.textNodes) this.nodeToUnit.set(text, unit.root);
    for (const text of written.textByNode.keys()) this.nodeToUnit.set(text, unit.root);
  }

  private clearInlineBusy(record: InlineUnitRecord): void {
    if (!record.busy) return;
    record.busy = false;
    this.counts.seen--;
    this.counts.failed--;
  }

  private clearBusy(node: Target, field: Field): void {
    if (!this.busy.get(node)?.delete(field)) return;
    this.counts.seen--;
    this.counts.failed--;
  }

  private undo(node: Target, field: Field, patch: Patch): void {
    if (readField(node, field) === patch.written) writeField(node, field, patch.original);
  }
}

function dirContainer(node: Target): Element | null {
  let fallback: Element | null = null;
  for (let current = isText(node) ? node.parentElement : node; current; current = current.parentElement) {
    const tag = current.localName;
    if (tag === 'html' || tag === 'body') break;
    if (tag === 'option' || tag === 'optgroup') continue;
    fallback ??= current;
    if (DIR_CONTAINERS.has(tag)) return current;
  }
  return fallback;
}

function restoreDir(element: Element, previous: string | null): void {
  if (element.getAttribute('dir') !== 'auto') return;
  if (previous === null) element.removeAttribute('dir');
  else element.setAttribute('dir', previous);
}
