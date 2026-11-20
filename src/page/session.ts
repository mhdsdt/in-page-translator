import { parseInlineHtml, validateInlineTranslation } from '../shared/inline-html';
import { OfflineError } from '../shared/offline';
import type { TranslationCache } from './engine';
import { buildInlineUnit, findInlineUnitRoot, isInlineFlowVisible } from './inline';
import type { InlineUnit } from './inline';
import { PatchLedger } from './patches';
import type { Counts } from './patches';
import { DomScanner } from './scanner';
import {
  eligible, fieldAllowed, fieldsOf, frameDocument, hasTranslatableDataAttribute,
  isElement, isText, isTranslatableButtonInput, isVisibleBlockedFrame, liveOnPage, policyAttributes,
  readField, textAttributes,
} from './surface';
import type { Field, SurfaceRoot, Target } from './surface';
import { Viewport } from './viewport';
import { ShadowDiscovery } from './shadow-discovery';

const SLICE_MS = 6;
const FIELDS_PER_BATCH = 32;
const TRANSLATION_LANES = 32;

interface Candidate {
  node: Target;
  field: Field;
  original: string;
}

export class PageSession {
  private readonly observers = new Map<SurfaceRoot, AbortController>();
  private readonly seen = new Map<Target, Candidate[]>();
  private readonly seenUnits = new Map<Element, InlineUnit>();
  private readonly inlineRoots = new WeakSet<Element>();
  private readonly inlineFallback = new WeakSet<Element>();
  private readonly slots = new WeakMap<HTMLSlotElement, Node[]>();
  private readonly knownFrames = new WeakSet<Element>();
  private readonly inaccessibleFrames = new Set<Element>();
  private readonly checkedPseudo = new WeakSet<Element>();
  private readonly pendingRepair = new Set<Node>();
  private readonly ledger: PatchLedger;
  private readonly scanner: DomScanner;
  private readonly viewport: Viewport;
  private readonly shadows: ShadowDiscovery;
  private running = false;

  constructor(
    private readonly document: Document,
    private readonly cache: TranslationCache,
    private readonly signal: AbortSignal,
    private readonly report: (counts: Readonly<Counts>, idle: boolean) => void,
    targetRtl = false,
  ) {
    this.ledger = new PatchLedger(targetRtl);
    this.scanner = new DomScanner(document, node => this.visit(node));
    this.shadows = new ShadowDiscovery(signal, root => {
      if (!liveOnPage(root, this.document)) return;
      this.observe(root);
      this.scanner.enqueue(root);
      this.schedule();
    });
    this.viewport = new Viewport(signal, target => this.onTargetSeen(target));
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
    this.seenUnits.clear();
    this.pendingRepair.clear();
    this.inaccessibleFrames.clear();
    await this.ledger.restoreAll(SLICE_MS, yieldToPage);
  }

  private onTargetSeen(target: Target): void {
    if (!eligible(target, this.document)) return;
    const includePseudo = isElement(target);
    if (includePseudo) this.checkedPseudo.add(target);

    if (isElement(target) && this.inlineRoots.has(target)) {
      this.inlineRoots.delete(target);
      const unit = !this.inlineFallback.has(target) ? buildInlineUnit(target, this.document) : null;
      if (unit && isInlineFlowVisible(unit)) {
        this.seenUnits.set(target, unit);
      } else {
        this.inlineFallback.add(target);
        this.enqueueInlineFallback(target);
      }
    }

    const fields = this.candidates(target, includePseudo);
    if (fields.length) this.seen.set(target, fields);
    if (this.seen.size || this.seenUnits.size || this.scanner.hasWork) this.schedule();
  }

  private enqueueInlineFallback(root: Element): void {
    const walker = this.document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      this.scanner.enqueue(node);
    }
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
        if (this.ledger.isOwnInlineMutation(record.target)) continue;
        const unitRec = this.ledger.unitFor(record.target);
        if (unitRec) {
          this.invalidateInlineUnit(unitRec.unit.root, false);
          changed = true;
        }
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
        if (this.ledger.isOwnInlineMutation(record.target)) continue;
        const unitRec = this.ledger.unitFor(record.target);
        if (unitRec) {
          this.invalidateInlineUnit(unitRec.unit.root, false);
          changed = true;
        } else if (this.onFieldChange(record.target, 'text')) {
          changed = true;
        }
      } else if (record.type === 'attributes' && isElement(record.target)) {
        const name = record.attributeName;
        if (name === 'style') {
          styleChanged = true;
          continue;
        }
        if (name === 'value') {
          if (record.target.localName === 'option') {
            this.scanner.enqueue(record.target);
            this.pendingRepair.add(record.target);
            changed = true;
          } else if (isTranslatableButtonInput(record.target)) {
            if (this.onFieldChange(record.target, 'value')) changed = true;
          }
          continue;
        }
        if (name === 'open') {
          if (record.target.localName === 'details' || record.target.localName === 'dialog') {
            this.scanner.enqueue(record.target);
            styleChanged = true;
            changed = true;
          }
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

  private invalidateInlineUnit(root: Element, restore: boolean): void {
    this.ledger.forgetInlineUnit(root, restore);
    this.inlineFallback.delete(root);
    this.inlineRoots.delete(root);
    this.seenUnits.delete(root);
    this.viewport.forget(root);
    this.scanner.enqueue(root);
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
      (!this.scanner.hasWork && !this.pendingRepair.size && !this.seen.size && !this.seenUnits.size)) return;
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

      if (this.seenUnits.size) {
        const units: InlineUnit[] = [];
        for (const [root, unit] of this.seenUnits) {
          this.seenUnits.delete(root);
          units.push(unit);
          if (units.length >= FIELDS_PER_BATCH || performance.now() >= deadline) break;
        }
        if (units.length) {
          await this.applyUnits(units);
          if (!this.signal.aborted) this.report(this.ledger.counts, false);
        }
      } else if (this.seen.size) {
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
    if (isText(node) && !this.seen.has(node)) {
      if (this.ledger.unitFor(node)) return;
      const fields = fieldsOf(node);
      if (!fields.length || fields.every(field => this.ledger.original(node, field) === undefined)) return;
      if (!eligible(node, this.document)) return;

      const unitRoot = findInlineUnitRoot(node, this.document);
      if (unitRoot && !this.inlineFallback.has(unitRoot)) {
        if (!this.ledger.hasUnit(unitRoot) && !this.seenUnits.has(unitRoot)) {
          this.inlineRoots.add(unitRoot);
          this.viewport.observe(unitRoot);
        }
        return;
      }
      this.viewport.observe(node);
      return;
    }

    if (isElement(node) && !this.seen.has(node)) {
      const fields = fieldsOf(node);
      const hasStandard = fields.length > 0 && fields.some(field => this.ledger.original(node, field) !== undefined);
      const needsPseudo = !hasStandard && !this.checkedPseudo.has(node) && hasTranslatableDataAttribute(node);
      if ((hasStandard || needsPseudo) && eligible(node, this.document)) {
        this.viewport.observe(node);
      }
    }
  }

  private candidates(node: Target, includePseudo = false): Candidate[] {
    const batch: Candidate[] = [];
    for (const field of fieldsOf(node, includePseudo)) {
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

  blockedFrameCount(): number {
    let count = 0;
    for (const frame of this.inaccessibleFrames) {
      if (!liveOnPage(frame, this.document) || frameDocument(frame) !== null) {
        this.inaccessibleFrames.delete(frame);
        continue;
      }
      if (isVisibleBlockedFrame(frame, this.document)) count++;
    }
    return count;
  }

  private discoverFrame(element: Element): void {
    const nested = frameDocument(element);
    if (!nested) {
      if (eligible(element, this.document)) this.inaccessibleFrames.add(element);
      return;
    }
    this.inaccessibleFrames.delete(element);
    if (!eligible(element, this.document)) return;
    this.observe(nested);
    this.scanner.enqueue(nested);
  }

  private async runLanes<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
    if (items.length === 0) return;
    let cursor = 0;
    const worker = async () => {
      while (!this.signal.aborted) {
        const item = items[cursor++];
        if (item === undefined) return;
        await run(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(TRANSLATION_LANES, items.length) }, worker));
  }

  private async applyUnits(units: InlineUnit[]): Promise<void> {
    await this.runLanes(units, async (unit) => {
      if (!this.matchesUnit(unit) || !this.ledger.beginInlineAttempt(unit)) return;
      let translatedHtml: string;
      try {
        translatedHtml = await this.cache.translateHtml(unit.html);
      } catch (error) {
        if (this.signal.aborted) return;
        if (!this.matchesUnit(unit)) {
          this.ledger.cancelInlineAttempt(unit.root, unit.html);
          return;
        }
        const retryAfterExit = error instanceof OfflineError && error.code === 'busy';
        this.ledger.recordInlineFailure(unit.root, unit.html, retryAfterExit);
        if (retryAfterExit) {
          this.inlineRoots.add(unit.root);
          this.viewport.observe(unit.root, true);
        }
        return;
      }
      if (this.signal.aborted) return;
      if (!this.matchesUnit(unit)) {
        this.ledger.cancelInlineAttempt(unit.root, unit.html);
        return;
      }
      const parsed = parseInlineHtml(translatedHtml, unit.slotIds);
      if (!validateInlineTranslation(parsed, unit.slotIds, unit.opaqueIds)) {
        this.ledger.cancelInlineAttempt(unit.root, unit.html);
        this.inlineFallback.add(unit.root);
        this.enqueueInlineFallback(unit.root);
        return;
      }
      this.ledger.applyInlineTranslation(unit, parsed.nodes);
    });
  }

  private matchesUnit(unit: InlineUnit): boolean {
    if (!eligible(unit.root, this.document)) return false;
    const current = buildInlineUnit(unit.root, this.document);
    return Boolean(current && current.html === unit.html);
  }

  private async applyBatch(batch: Candidate[]): Promise<void> {
    await this.runLanes(batch, async (candidate) => {
      const { node, field, original } = candidate;
      if (!this.matches(candidate) || !this.ledger.beginAttempt(node, field, original)) return;
      let written: string;
      try {
        written = await this.cache.translate(original);
      } catch (error) {
        if (this.signal.aborted) return;
        if (!this.matches(candidate)) {
          this.ledger.cancelAttempt(node, field, original);
          return;
        }
        const retryAfterExit = error instanceof OfflineError && error.code === 'busy';
        this.ledger.recordFailure(node, field, original, retryAfterExit);
        if (retryAfterExit) this.viewport.observe(node, true);
        return;
      }
      if (this.signal.aborted) return;
      if (!this.matches(candidate)) {
        // Node changed or temporarily became ineligible mid-flight; don't poison future scans.
        this.ledger.cancelAttempt(node, field, original);
        return;
      }
      this.ledger.applyTranslation(node, field, original, written);
    });
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
      if (!liveOnPage(node, this.document)) {
        this.shadows.forget(node);
        this.inaccessibleFrames.delete(node);
      }
      if (isSlot(node)) this.queueAssigned(node);
    }
    const unitBefore = !allowed ? this.ledger.unitFor(node) : undefined;
    this.ledger.repairNode(node, allowed);
    if (!allowed) {
      if (isElement(node)) {
        this.checkedPseudo.delete(node);
        this.inlineRoots.delete(node);
        this.inlineFallback.delete(node);
        this.seenUnits.delete(node);
      }
      if (unitBefore && unitBefore.unit.root !== node && eligible(unitBefore.unit.root, this.document)) {
        this.inlineFallback.delete(unitBefore.unit.root);
        this.scanner.enqueue(unitBefore.unit.root);
      }
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
