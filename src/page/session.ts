import type { TranslationCache } from './engine';
import { OfflineError } from '../shared/offline';
import {
  canTranslate, eligible, fieldAllowed, fieldsOf, frameDocument, isElement, isSkippedElement,
  isText, liveOnPage, policyAttributes, readField, textAttributes, writeField,
} from './surface';
import type { Field, SurfaceRoot, Target } from './surface';
import { Viewport } from './viewport';
import { ShadowDiscovery } from './shadow-discovery';

const SLICE_MS = 6;
const NODES_PER_SLICE = 400;
const FIELDS_PER_BATCH = 24;
const TRANSLATION_LANES = 12;

interface Candidate {
  node: Target;
  field: Field;
  original: string;
}

interface Patch {
  original: string;
  written: string;
}

interface Counts {
  seen: number;
  updated: number;
  failed: number;
}

export class PageSession {
  private readonly pending = new Set<Node>();
  private readonly observers = new Map<SurfaceRoot, AbortController>();
  private readonly seen = new Map<Target, Candidate[]>();
  private readonly busy = new WeakMap<Target, Set<Field>>();
  private readonly attempted = new WeakMap<Target, Map<Field, string>>();
  private readonly viewport: Viewport;
  private readonly shadows: ShadowDiscovery;
  private readonly slots = new WeakMap<HTMLSlotElement, Node[]>();
  private scanCursor?: { root: Node; walker: TreeWalker };
  private readonly knownFrames = new WeakSet<Element>();
  private readonly patches = new Map<Target, Map<Field, Patch>>();
  private readonly counts: Counts = { seen: 0, updated: 0, failed: 0 };
  private running = false;
  private readonly pendingRepair = new Set<Node>();

  constructor(
    private readonly document: Document,
    private readonly cache: TranslationCache,
    private readonly signal: AbortSignal,
    private readonly report: (counts: Readonly<Counts>, idle: boolean) => void,
  ) {
    this.shadows = new ShadowDiscovery(signal, root => {
      if (!liveOnPage(root, this.document)) return;
      this.observe(root);
      this.enqueue(root);
      this.schedule();
    });
    this.viewport = new Viewport(signal, target => {
      if (!eligible(target, this.document)) return;
      const fields = this.candidates(target);
      if (fields.length) {
        this.seen.set(target, fields);
        this.schedule();
      }
    });
  }

  start(): void {
    this.observe(this.document);
    this.enqueue(this.document);
    this.schedule();
  }

  async restore(): Promise<void> {
    for (const observer of this.observers.values()) observer.abort();
    this.observers.clear();
    this.pending.clear();
    this.seen.clear();
    this.scanCursor = undefined;
    this.pendingRepair.clear();

    let deadline = performance.now() + SLICE_MS;
    for (const [node, fields] of this.patches) {
      for (const [field, patch] of fields) this.undo(node, field, patch);
      if (performance.now() >= deadline) {
        await yieldToPage();
        deadline = performance.now() + SLICE_MS;
      }
    }
    this.patches.clear();
  }

  private observe(root: SurfaceRoot): void {
    if (this.observers.has(root)) return;
    const observer = new MutationObserver(records => this.onChanges(records));
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: [...textAttributes, ...policyAttributes, 'style', 'slot'],
    });
    const lifetime = new AbortController();
    lifetime.signal.addEventListener('abort', () => observer.disconnect(), { once: true });
    this.viewport.listen(root, lifetime.signal);
    if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      root.addEventListener('slotchange', event => {
        const slot = event.target as HTMLSlotElement;
        if (typeof slot?.assignedNodes !== 'function') return;
        this.queueAssigned(slot);
        this.schedule();
      }, { signal: lifetime.signal });
    }
    this.observers.set(root, lifetime);
  }

  private onChanges(records: MutationRecord[]): void {
    if (this.signal.aborted) return;
    let changed = false;
    let styleChanged = false;
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of record.addedNodes) {
          this.enqueue(node);
          changed = true;
        }
        for (const node of record.removedNodes) {
          if (isElement(node) || isText(node)) {
            this.pendingRepair.add(node);
            changed = true;
          }
        }
      } else if (record.type === 'characterData' && isText(record.target)) {
        if (this.onFieldChange(record.target, 'text')) changed = true;
      } else if (record.type === 'attributes' && isElement(record.target)) {
        const name = record.attributeName;
        if (name === 'style') {
          styleChanged = true;
          continue;
        }
        if (name === 'class') {
          const previouslySkipped = /(?:^|[\t\n\f\r ])notranslate(?:$|[\t\n\f\r ])/u
            .test(record.oldValue ?? '');
          if (previouslySkipped === record.target.classList.contains('notranslate')) {
            styleChanged = true;
            continue;
          }
        }
        if (name === 'class' || name === 'hidden' ||
          name === 'translate' || name === 'contenteditable' || name === 'slot') {
          this.enqueue(record.target);
          this.pendingRepair.add(record.target);
          changed = true;
        } else if (name) {
          if (this.onFieldChange(record.target, name as Field)) changed = true;
        }
      }
    }
    if (styleChanged) this.viewport.refreshHidden();
    if (changed) {
      this.viewport.refresh();
      this.schedule();
    }
  }

  private onFieldChange(node: Target, field: Field): boolean {
    const fields = this.patches.get(node);
    const patch = fields?.get(field);
    if (patch && readField(node, field) === patch.written) return false;
    this.attempted.get(node)?.delete(field);
    this.clearBusy(node, field);
    this.seen.delete(node);
    this.viewport.forget(node);
    if (fields) {
      fields.delete(field);
      if (!fields.size) this.patches.delete(node);
    }
    this.enqueue(node);
    return true;
  }

  private enqueue(node: Node): void {
    if (isElement(node) || isText(node) || node.nodeType === Node.DOCUMENT_NODE ||
      node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      this.pending.add(node);
    }
  }

  private schedule(): void {
    if (this.running || this.signal.aborted ||
      (!this.pending.size && !this.pendingRepair.size && !this.seen.size && !this.scanCursor)) return;
    this.running = true;
    void this.drain().finally(() => {
      this.running = false;
      this.schedule();
    });
  }

  private async drain(): Promise<void> {
    let deadline = performance.now() + SLICE_MS;
    while (!this.signal.aborted) {
      if (this.pendingRepair.size) await this.repair();
      if (this.signal.aborted) return;

      if (this.seen.size) {
        const batch: Candidate[] = [];
        for (const [target, fields] of this.seen) {
          this.seen.delete(target);
          batch.push(...fields);
          if (batch.length >= FIELDS_PER_BATCH || performance.now() >= deadline) break;
        }
        if (batch.length) {
          await this.applyBatch(batch);
          if (!this.signal.aborted) this.report(this.counts, false);
        }
      } else {
        if (!this.scanCursor) {
          const next = this.pending.values().next();
          if (next.done) {
            this.report(this.counts, true);
            return;
          }
          this.pending.delete(next.value);
          this.beginScan(next.value);
        }
        this.discoverSlice(deadline);
      }
      if (performance.now() >= deadline || this.scanCursor) {
        await yieldToPage();
        deadline = performance.now() + SLICE_MS;
      }
    }
  }

  private beginScan(root: Node): void {
    if (!liveOnPage(root, this.document)) return;
    if (isElement(root) && isSkippedElement(root)) return;
    this.visit(root);
    if (isText(root)) return;
    const walker = this.document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      node => (isElement(node) && isSkippedElement(node)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    );
    this.scanCursor = { root, walker };
  }

  private discoverSlice(deadline: number): void {
    const cursor = this.scanCursor;
    if (!cursor) return;
    if (!liveOnPage(cursor.root, this.document)) {
      this.scanCursor = undefined;
      return;
    }
    // If the exact node at the previous yield boundary was removed, restart from its live root.
    if (!liveOnPage(cursor.walker.currentNode, this.document)) {
      cursor.walker.currentNode = cursor.root;
    }

    for (let visited = 0; visited < NODES_PER_SLICE; visited++) {
      const node = cursor.walker.nextNode();
      if (!node) {
        this.scanCursor = undefined;
        return;
      }
      this.visit(node);
      if (performance.now() >= deadline) return;
    }
  }

  private visit(node: Node): void {
    if (isElement(node)) this.discoverRoots(node);
    if ((isText(node) || isElement(node)) && !this.seen.has(node)) {
      const fields = fieldsOf(node);
      // Check text eligibility before walking ancestors to skip whitespace-only nodes in O(1).
      if (fields.length &&
        fields.some(field => this.original(node, field) !== undefined) &&
        eligible(node, this.document)) {
        this.viewport.observe(node);
      }
    }
  }

  private candidates(node: Target): Candidate[] {
    const batch: Candidate[] = [];
    for (const field of fieldsOf(node)) {
      const original = this.original(node, field);
      if (original !== undefined) batch.push({ node, field, original });
    }
    return batch;
  }

  private original(node: Target, field: Field): string | undefined {
    const value = readField(node, field);
    if (value !== null && this.attempted.get(node)?.get(field) !== value &&
      this.patches.get(node)?.get(field)?.written !== value && canTranslate(value)) return value;
  }

  private discoverRoots(element: Element): void {
    this.shadows.inspect(element);
    if (isSlot(element) && !this.slots.has(element)) this.slots.set(element, element.assignedNodes());
    if (element.localName === 'iframe' || element.localName === 'frame') {
      if (!this.knownFrames.has(element)) {
        this.knownFrames.add(element);
        element.addEventListener('load', () => {
          this.pendingRepair.add(element);
          this.discoverFrame(element);
          this.schedule();
        }, { signal: this.signal });
      }
      this.discoverFrame(element);
    }
  }

  private discoverFrame(element: Element): void {
    const nested = frameDocument(element);
    if (!nested || !eligible(element, this.document)) return;
    this.observe(nested);
    this.enqueue(nested);
  }

  private async applyBatch(batch: Candidate[]): Promise<void> {
    let cursor = 0;
    const runLane = async () => {
      while (!this.signal.aborted) {
        const candidate = batch[cursor++];
        if (!candidate) return;
        const { node, field, original } = candidate;
        if (!this.matches(candidate) || this.attempted.get(node)?.get(field) === original) continue;
        let attempts = this.attempted.get(node);
        if (!attempts) {
          attempts = new Map();
          this.attempted.set(node, attempts);
        }
        attempts.set(field, original);
        this.clearBusy(node, field);
        this.counts.seen++;
        let written: string;
        try {
          written = await this.cache.translate(original);
        } catch (error) {
          if (this.signal.aborted) continue;
          if (!this.matches(candidate)) {
            if (attempts.get(field) === original) attempts.delete(field);
            this.counts.seen--;
            continue;
          }
          this.counts.failed++;
          if (error instanceof OfflineError && error.code === 'busy') {
            if (attempts.get(field) === original) attempts.delete(field);
            let deferred = this.busy.get(node);
            if (!deferred) {
              deferred = new Set();
              this.busy.set(node, deferred);
            }
            deferred.add(field);
            this.viewport.observe(node, true);
          }
          continue;
        }
        if (this.signal.aborted) continue;
        if (!this.matches(candidate)) {
          // Node changed or temporarily became ineligible mid-flight; don't poison future scans.
          if (attempts.get(field) === original) attempts.delete(field);
          this.counts.seen--;
          continue;
        }
        if (original !== written) {
          let fields = this.patches.get(node);
          if (!fields) {
            fields = new Map();
            this.patches.set(node, fields);
          }
          fields.set(field, { original, written });
          writeField(node, field, written);
          this.counts.updated++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(TRANSLATION_LANES, batch.length) }, runLane));
  }

  private clearBusy(node: Target, field: Field): void {
    if (!this.busy.get(node)?.delete(field)) return;
    this.counts.seen--;
    this.counts.failed--;
  }

  private matches({ node, field, original }: Candidate): boolean {
    return fieldAllowed(node, field) && readField(node, field) === original && eligible(node, this.document);
  }

  private async repair(): Promise<void> {
    // Check removed or newly excluded subtrees, leaving unrelated patches alone.
    for (const [root, observer] of this.observers) {
      if (!liveOnPage(root, this.document)) {
        observer.abort();
        this.observers.delete(root);
        this.pendingRepair.add(root);
      } else if (!eligible(root, this.document)) {
        this.pendingRepair.add(root);
      }
    }

    let deadline = performance.now() + SLICE_MS;
    const roots = [...this.pendingRepair];
    this.pendingRepair.clear();
    for (const root of roots) {
      const iterator = this.document.createNodeIterator(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let node = iterator.nextNode(); node; node = iterator.nextNode()) {
        if (this.signal.aborted) return;
        if (isText(node) || isElement(node)) this.repairTarget(node);
        if (performance.now() >= deadline) {
          await yieldToPage();
          deadline = performance.now() + SLICE_MS;
        }
      }
    }
  }

  private queueAssigned(slot: HTMLSlotElement): void {
    const current = slot.assignedNodes();
    for (const node of new Set([...(this.slots.get(slot) ?? []), ...current])) {
      this.pendingRepair.add(node);
      this.enqueue(node);
    }
    this.slots.set(slot, current);
  }

  private repairTarget(node: Target): void {
    const allowed = eligible(node, this.document);
    if (isElement(node)) {
      if (!liveOnPage(node, this.document)) this.shadows.forget(node);
      if (isSlot(node)) this.queueAssigned(node);
    }
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
      this.viewport.forget(node);
      this.seen.delete(node);
      this.attempted.delete(node);
      for (const field of this.busy.get(node) ?? []) this.clearBusy(node, field);
    } else if (isText(node)) {
      // A moved text node may now have a different clipping element.
      this.viewport.forget(node);
      this.enqueue(node);
    }
  }

  private undo(node: Target, field: Field, patch: Patch): void {
    if (readField(node, field) === patch.written) writeField(node, field, patch.original);
  }
}

function isSlot(element: Element): element is HTMLSlotElement {
  return element.localName === 'slot' && typeof (element as HTMLSlotElement).assignedNodes === 'function';
}

function yieldToPage(): Promise<void> {
  // Task scheduling keeps input responsive even when all translations hit the cache.
  const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield(): Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  return new Promise(resolve => window.setTimeout(resolve, 0));
}
