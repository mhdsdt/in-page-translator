import type { TranslationCache } from './engine';
import { OfflineError } from '../shared/offline';
import { PatchLedger } from './patches';
import type { Counts } from './patches';
import { DomScanner } from './scanner';
import {
  eligible, fieldAllowed, fieldsOf, frameDocument, isElement,
  isText, liveOnPage, policyAttributes, readField, textAttributes,
} from './surface';
import type { Field, SurfaceRoot, Target } from './surface';
import { Viewport } from './viewport';
import { ShadowDiscovery } from './shadow-discovery';

const SLICE_MS = 6;
const FIELDS_PER_BATCH = 24;
const TRANSLATION_LANES = 12;

interface Candidate {
  node: Target;
  field: Field;
  original: string;
}

export class PageSession {
  private readonly observers = new Map<SurfaceRoot, AbortController>();
  private readonly seen = new Map<Target, Candidate[]>();
  private readonly slots = new WeakMap<HTMLSlotElement, Node[]>();
  private readonly knownFrames = new WeakSet<Element>();
  private readonly pendingRepair = new Set<Node>();
  private readonly ledger = new PatchLedger();
  private readonly scanner: DomScanner;
  private readonly viewport: Viewport;
  private readonly shadows: ShadowDiscovery;
  private running = false;

  constructor(
    private readonly document: Document,
    private readonly cache: TranslationCache,
    private readonly signal: AbortSignal,
    private readonly report: (counts: Readonly<Counts>, idle: boolean) => void,
  ) {
    this.scanner = new DomScanner(document, node => this.visit(node));
    this.shadows = new ShadowDiscovery(signal, root => {
      if (!liveOnPage(root, this.document)) return;
      this.observe(root);
      this.scanner.enqueue(root);
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
    this.scanner.enqueue(this.document);
    this.schedule();
  }

  async restore(): Promise<void> {
    for (const observer of this.observers.values()) observer.abort();
    this.observers.clear();
    this.scanner.clear();
    this.seen.clear();
    this.pendingRepair.clear();
    await this.ledger.restoreAll(SLICE_MS, yieldToPage);
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
          this.scanner.enqueue(node);
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
          this.scanner.enqueue(record.target);
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
    if (this.ledger.isOwnWrite(node, field)) return false;
    this.ledger.forgetField(node, field);
    this.seen.delete(node);
    this.viewport.forget(node);
    this.scanner.enqueue(node);
    return true;
  }

  private schedule(): void {
    if (this.running || this.signal.aborted ||
      (!this.scanner.hasWork && !this.pendingRepair.size && !this.seen.size)) return;
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
          if (!this.signal.aborted) this.report(this.ledger.counts, false);
        }
      } else if (!this.scanner.step(deadline)) {
        this.report(this.ledger.counts, true);
        return;
      }

      if (performance.now() >= deadline || this.scanner.active) {
        await yieldToPage();
        deadline = performance.now() + SLICE_MS;
      }
    }
  }

  private visit(node: Node): void {
    if (isElement(node)) this.discoverRoots(node);
    if ((isText(node) || isElement(node)) && !this.seen.has(node)) {
      const fields = fieldsOf(node);
      // Check text eligibility before walking ancestors to skip whitespace-only nodes in O(1).
      if (fields.length &&
        fields.some(field => this.ledger.original(node, field) !== undefined) &&
        eligible(node, this.document)) {
        this.viewport.observe(node);
      }
    }
  }

  private candidates(node: Target): Candidate[] {
    const batch: Candidate[] = [];
    for (const field of fieldsOf(node)) {
      const original = this.ledger.original(node, field);
      if (original !== undefined) batch.push({ node, field, original });
    }
    return batch;
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
    this.scanner.enqueue(nested);
  }

  private async applyBatch(batch: Candidate[]): Promise<void> {
    let cursor = 0;
    const runLane = async () => {
      while (!this.signal.aborted) {
        const candidate = batch[cursor++];
        if (!candidate) return;
        const { node, field, original } = candidate;
        if (!this.matches(candidate) || !this.ledger.beginAttempt(node, field, original)) continue;
        let written: string;
        try {
          written = await this.cache.translate(original);
        } catch (error) {
          if (this.signal.aborted) continue;
          if (!this.matches(candidate)) {
            this.ledger.cancelAttempt(node, field, original);
            continue;
          }
          const retryAfterExit = error instanceof OfflineError && error.code === 'busy';
          this.ledger.recordFailure(node, field, original, retryAfterExit);
          if (retryAfterExit) this.viewport.observe(node, true);
          continue;
        }
        if (this.signal.aborted) continue;
        if (!this.matches(candidate)) {
          // Node changed or temporarily became ineligible mid-flight; don't poison future scans.
          this.ledger.cancelAttempt(node, field, original);
          continue;
        }
        this.ledger.applyTranslation(node, field, original, written);
      }
    };
    await Promise.all(Array.from({ length: Math.min(TRANSLATION_LANES, batch.length) }, runLane));
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
      this.scanner.enqueue(node);
    }
    this.slots.set(slot, current);
  }

  private repairTarget(node: Target): void {
    const allowed = eligible(node, this.document);
    if (isElement(node)) {
      if (!liveOnPage(node, this.document)) this.shadows.forget(node);
      if (isSlot(node)) this.queueAssigned(node);
    }
    this.ledger.repairNode(node, allowed);
    if (!allowed) {
      this.viewport.forget(node);
      this.seen.delete(node);
    } else if (isText(node)) {
      // A moved text node may now have a different clipping element.
      this.viewport.forget(node);
      this.scanner.enqueue(node);
    }
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
