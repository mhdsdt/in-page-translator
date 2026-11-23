import { parseInlineHtml, validateInlineTranslation } from '../shared/inline-html';
import { OfflineError } from '../shared/offline';
import type { TranslationCache } from './engine';
import { buildInlineUnit, findInlineUnitRoot, isInlineFlowVisible } from './inline';
import type { InlineUnit, KnownInlineRoots } from './inline';
import { PatchLedger } from './patches';
import type { Counts } from './patches';
import { SurfaceTracker } from './roots';
import { DomScanner } from './scanner';
import {
  eligible, fieldAllowed, fieldsOf, hasTranslatableDataAttribute, isElement, isText,
  isTranslatableButtonInput, liveOnPage, readField,
} from './surface';
import type { Field, Target } from './surface';
import { Viewport } from './viewport';

const SLICE_MS = 6;
const MAX_IN_FLIGHT = 64;
const PROGRESS_INTERVAL_MS = 80;
const OBSERVER_SETTLE_MS = 40;

interface Candidate {
  node: Target;
  field: Field;
  original: string;
}

export class PageSession {
  private readonly seen = new Map<Target, Candidate[]>();
  private readonly seenLater = new Map<Target, Candidate[]>();
  private readonly seenUnits = new Map<Element, InlineUnit>();
  private readonly seenUnitsLater = new Map<Element, InlineUnit>();
  private readonly inlineRoots = new WeakSet<Element>();
  private readonly inlineFallback = new WeakSet<Element>();
  private readonly checkedPseudo = new WeakSet<Element>();
  private readonly pendingRepair = new Set<Node>();
  private readonly ledger: PatchLedger;
  private readonly scanner: DomScanner;
  private readonly viewport: Viewport;
  private readonly roots: SurfaceTracker;
  private readonly knownUnits: KnownInlineRoots;
  private running = false;
  private activeTranslations = 0;
  private needsIdleReport = false;
  private reportedTranslating = false;
  private initialSettled = false;
  private progressTimer?: number;

  constructor(
    private readonly document: Document,
    private readonly cache: TranslationCache,
    private readonly signal: AbortSignal,
    private readonly report: (counts: Readonly<Counts>, idle: boolean) => void,
    targetRtl = false,
  ) {
    this.ledger = new PatchLedger(targetRtl);
    this.knownUnits = {
      hasUnit: root => this.inlineRoots.has(root) || this.ledger.hasUnit(root) ||
        this.seenUnits.has(root) || this.seenUnitsLater.has(root),
      hasFallback: root => this.inlineFallback.has(root),
    };
    this.scanner = new DomScanner(document, node => this.visit(node));
    this.viewport = new Viewport(signal, (target, inViewport) => this.onTargetSeen(target, inViewport));
    this.roots = new SurfaceTracker(
      document,
      signal,
      records => this.onChanges(records),
      (root, lifetime) => this.viewport.listen(root, lifetime),
      root => {
        this.needsIdleReport = true;
        this.scanner.enqueue(root);
        this.schedule();
      },
      (nodes, rescan) => {
        this.needsIdleReport = true;
        for (const node of nodes) {
          this.pendingRepair.add(node);
          if (rescan) this.scanner.enqueue(node);
        }
        this.schedule();
      },
    );
    signal.addEventListener('abort', () => this.clearProgressTimer(), { once: true });
  }

  start(): void {
    this.needsIdleReport = true;
    this.reportedTranslating = false;
    this.initialSettled = false;
    this.roots.observe(this.document);
    this.scanner.enqueue(this.document);
    this.schedule();
  }

  blockedFrameCount(): number {
    return this.roots.blockedFrameCount();
  }

  async restore(): Promise<void> {
    this.clearProgressTimer();
    this.needsIdleReport = false;
    this.reportedTranslating = false;
    this.initialSettled = false;
    this.roots.clear();
    this.scanner.clear();
    this.seen.clear();
    this.seenLater.clear();
    this.seenUnits.clear();
    this.seenUnitsLater.clear();
    this.pendingRepair.clear();
    await this.ledger.restoreAll(SLICE_MS, yieldToPage);
  }

  private clearProgressTimer(): void {
    window.clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
  }

  private scheduleProgressReport(): void {
    if (this.progressTimer !== undefined || this.signal.aborted || this.activeTranslations === 0) return;
    this.progressTimer = window.setTimeout(() => {
      this.progressTimer = undefined;
      if (!this.signal.aborted && this.activeTranslations > 0) {
        this.reportedTranslating = true;
        this.report(this.ledger.counts, false);
      }
    }, PROGRESS_INTERVAL_MS);
  }

  private hasQueued(): boolean {
    return Boolean(this.seen.size || this.seenLater.size || this.seenUnits.size || this.seenUnitsLater.size);
  }

  private onTargetSeen(target: Target, inViewport: boolean): void {
    if (!eligible(target, this.document)) return;
    const includePseudo = isElement(target);
    if (includePseudo) this.checkedPseudo.add(target);

    if (isElement(target) && this.inlineRoots.has(target)) {
      this.inlineRoots.delete(target);
      const unit = !this.inlineFallback.has(target) ? buildInlineUnit(target, this.document) : null;
      if (unit && isInlineFlowVisible(unit)) {
        if (enqueueByPriority(this.seenUnits, this.seenUnitsLater, target, unit, inViewport, false)) {
          this.needsIdleReport = true;
        }
      } else {
        this.inlineFallback.add(target);
        this.enqueueInlineFallback(target);
      }
    }

    const fields = this.candidates(target, includePseudo);
    if (fields.length && enqueueByPriority(this.seen, this.seenLater, target, fields, inViewport, true)) {
      this.needsIdleReport = true;
    }
    if (this.hasQueued() || this.scanner.hasWork) this.schedule();
  }

  private enqueueInlineFallback(root: Element): void {
    const walker = this.document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      this.scanner.enqueue(node);
    }
    this.needsIdleReport = true;
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
        } else if (name && this.onFieldChange(record.target, name as Field)) {
          changed = true;
        }
      }
    }
    if (styleChanged) this.viewport.refreshHidden();
    if (changed) {
      this.needsIdleReport = true;
      this.viewport.refresh();
      this.schedule();
    }
  }

  private invalidateInlineUnit(root: Element, restore: boolean): void {
    this.ledger.forgetInlineUnit(root, restore);
    this.inlineFallback.delete(root);
    this.inlineRoots.delete(root);
    this.seenUnits.delete(root);
    this.seenUnitsLater.delete(root);
    this.viewport.forget(root);
    this.scanner.enqueue(root);
  }

  private onFieldChange(node: Target, field: Field): boolean {
    if (this.ledger.isOwnWrite(node, field)) return false;
    this.ledger.forgetField(node, field);
    this.seen.delete(node);
    this.seenLater.delete(node);
    this.viewport.forget(node);
    this.scanner.enqueue(node);
    return true;
  }

  private schedule(): void {
    if (this.running || this.signal.aborted) return;
    const canDispatch = this.hasQueued() && this.activeTranslations < MAX_IN_FLIGHT;
    const canFinish = this.needsIdleReport && this.activeTranslations === 0 && !this.hasQueued();
    if (!this.scanner.hasWork && !this.pendingRepair.size && !canDispatch && !canFinish) return;
    this.running = true;
    void this.drain().finally(() => {
      this.running = false;
      this.schedule();
    });
  }

  private async drain(): Promise<void> {
    let deadline = performance.now() + SLICE_MS;
    while (!this.signal.aborted) {
      if (this.pendingRepair.size) {
        this.needsIdleReport = true;
        await this.repair();
      }
      if (this.signal.aborted) return;

      const dispatched = this.dispatchPending();
      const scanned = this.scanner.step(deadline);

      if (!dispatched && !scanned) {
        if (this.pendingRepair.size) continue;
        if (this.activeTranslations === 0 && !this.hasQueued() && this.needsIdleReport) {
          if (!this.initialSettled && this.ledger.counts.seen === 0) {
            this.initialSettled = true;
            await yieldToObserver();
            continue;
          }
          this.initialSettled = true;
          this.needsIdleReport = false;
          this.reportedTranslating = false;
          this.clearProgressTimer();
          this.report(this.ledger.counts, true);
        }
        return;
      }

      if (performance.now() >= deadline || this.scanner.active) {
        await yieldToPage();
        deadline = performance.now() + SLICE_MS;
      }
    }
  }

  private dispatchPending(): boolean {
    let launched = false;
    while (!this.signal.aborted && this.activeTranslations < MAX_IN_FLIGHT) {
      const candidateQueue = this.seen.size ? this.seen
        : !this.seenUnits.size && this.seenLater.size ? this.seenLater
          : undefined;
      const nextCandidate = candidateQueue && takeFirst(candidateQueue);
      if (nextCandidate) {
        launched = true;
        for (const candidate of nextCandidate[1]) void this.translateCandidate(candidate);
        continue;
      }

      const unitQueue = this.seenUnits.size ? this.seenUnits
        : this.seenUnitsLater.size ? this.seenUnitsLater
          : undefined;
      const nextUnit = unitQueue && takeFirst(unitQueue);
      if (nextUnit) {
        launched = true;
        void this.translateUnit(nextUnit[1]);
        continue;
      }
      break;
    }
    if (launched && this.activeTranslations > 0 && !this.reportedTranslating) {
      this.reportedTranslating = true;
      this.report(this.ledger.counts, false);
    }
    return launched;
  }

  private async executeAttempt<R>(
    request: () => Promise<R>,
    stillValid: () => boolean,
    onCancel: () => void,
    onError: (retryAfterExit: boolean) => void,
    onSuccess: (result: R) => void,
  ): Promise<void> {
    this.activeTranslations++;
    this.needsIdleReport = true;
    try {
      let result: R;
      try {
        result = await request();
      } catch (error) {
        if (this.signal.aborted) return;
        if (!stillValid()) {
          onCancel();
          return;
        }
        onError(error instanceof OfflineError && error.code === 'busy');
        return;
      }
      if (this.signal.aborted) return;
      if (!stillValid()) {
        onCancel();
        return;
      }
      onSuccess(result);
    } finally {
      this.activeTranslations--;
      if (!this.signal.aborted) {
        this.scheduleProgressReport();
        this.schedule();
      }
    }
  }

  private translateCandidate(candidate: Candidate): Promise<void> {
    const { node, field, original } = candidate;
    if (this.signal.aborted || !this.matches(candidate) || !this.ledger.beginAttempt(node, field, original)) {
      return Promise.resolve();
    }
    return this.executeAttempt(
      () => this.cache.translate(original),
      () => this.matches(candidate),
      () => this.ledger.cancelAttempt(node, field, original),
      retryAfterExit => {
        this.ledger.recordFailure(node, field, original, retryAfterExit);
        if (retryAfterExit) this.viewport.observe(node, true);
      },
      written => this.ledger.applyTranslation(node, field, original, written),
    );
  }

  private translateUnit(unit: InlineUnit): Promise<void> {
    if (this.signal.aborted || !this.matchesUnit(unit) || !this.ledger.beginInlineAttempt(unit)) {
      return Promise.resolve();
    }
    return this.executeAttempt(
      () => this.cache.translateHtml(unit.html),
      () => this.matchesUnit(unit),
      () => this.ledger.cancelInlineAttempt(unit.root, unit.html),
      retryAfterExit => {
        this.ledger.recordInlineFailure(unit.root, unit.html, retryAfterExit);
        if (retryAfterExit) {
          this.inlineRoots.add(unit.root);
          this.viewport.observe(unit.root, true);
        }
      },
      translatedHtml => {
        const parsed = parseInlineHtml(translatedHtml, unit.slotIds);
        if (!validateInlineTranslation(parsed, unit.slotIds, unit.opaqueIds)) {
          this.ledger.cancelInlineAttempt(unit.root, unit.html);
          this.inlineFallback.add(unit.root);
          this.enqueueInlineFallback(unit.root);
          return;
        }
        this.ledger.applyInlineTranslation(unit, parsed.nodes);
      },
    );
  }

  private visit(node: Node): void {
    if (isElement(node)) this.roots.inspect(node);
    if (isText(node) && !this.seen.has(node) && !this.seenLater.has(node)) {
      if (this.ledger.unitFor(node)) return;
      const fields = fieldsOf(node);
      if (!fields.length || fields.every(field => this.ledger.original(node, field) === undefined)) return;
      if (!eligible(node, this.document)) return;

      const unitRoot = findInlineUnitRoot(node, this.document, this.knownUnits);
      if (unitRoot && !this.inlineFallback.has(unitRoot)) {
        if (!this.ledger.hasUnit(unitRoot) && !this.seenUnits.has(unitRoot) && !this.seenUnitsLater.has(unitRoot)) {
          this.inlineRoots.add(unitRoot);
          this.viewport.observe(unitRoot);
        }
        return;
      }
      this.viewport.observe(node);
      return;
    }

    if (isElement(node) && !this.seen.has(node) && !this.seenLater.has(node)) {
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

  private matchesUnit(unit: InlineUnit): boolean {
    if (!eligible(unit.root, this.document)) return false;
    const current = buildInlineUnit(unit.root, this.document);
    return Boolean(current && current.html === unit.html);
  }

  private matches({ node, field, original }: Candidate): boolean {
    return fieldAllowed(node, field) && readField(node, field) === original && eligible(node, this.document);
  }

  private async repair(): Promise<void> {
    for (const root of this.roots.collectInvalidRoots()) {
      this.pendingRepair.add(root);
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

  private repairTarget(node: Target): void {
    const allowed = eligible(node, this.document);
    if (isElement(node)) {
      this.roots.onElementRepaired(node, liveOnPage(node, this.document));
    }
    const unitBefore = !allowed ? this.ledger.unitFor(node) : undefined;
    this.ledger.repairNode(node, allowed);
    if (!allowed) {
      if (isElement(node)) {
        this.checkedPseudo.delete(node);
        this.inlineRoots.delete(node);
        this.inlineFallback.delete(node);
        this.seenUnits.delete(node);
        this.seenUnitsLater.delete(node);
      }
      if (unitBefore && unitBefore.unit.root !== node && eligible(unitBefore.unit.root, this.document)) {
        this.inlineFallback.delete(unitBefore.unit.root);
        this.scanner.enqueue(unitBefore.unit.root);
      }
      this.viewport.forget(node);
      this.seen.delete(node);
      this.seenLater.delete(node);
    } else if (isText(node)) {
      this.viewport.forget(node);
      this.scanner.enqueue(node);
    }
  }
}

function enqueueByPriority<K, V>(
  primary: Map<K, V>,
  secondary: Map<K, V>,
  key: K,
  value: V,
  inViewport: boolean,
  overwritePrimary: boolean,
): boolean {
  const queue = inViewport ? primary : secondary;
  const other = inViewport ? secondary : primary;
  if (inViewport) other.delete(key);
  if ((overwritePrimary || !queue.has(key)) && (inViewport || !other.has(key))) {
    queue.set(key, value);
    return true;
  }
  return false;
}

function takeFirst<K, V>(map: Map<K, V>): [K, V] | undefined {
  const next = map.entries().next();
  if (next.done) return undefined;
  map.delete(next.value[0]);
  return next.value;
}

function yieldToPage(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield(): Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  return new Promise(resolve => window.setTimeout(resolve, 0));
}

function yieldToObserver(): Promise<void> {
  return new Promise(resolve => {
    const fallback = window.setTimeout(resolve, OBSERVER_SETTLE_MS);
    window.requestAnimationFrame(() => {
      window.clearTimeout(fallback);
      window.setTimeout(resolve, 0);
    });
  });
}
