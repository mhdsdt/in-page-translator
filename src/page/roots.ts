import { ShadowDiscovery } from './shadow-discovery';
import {
  eligible, frameDocument, isVisibleBlockedFrame, liveOnPage, policyAttributes, textAttributes,
} from './surface';
import type { SurfaceRoot } from './surface';

export class SurfaceTracker {
  private readonly observers = new Map<SurfaceRoot, AbortController>();
  private readonly slots = new WeakMap<HTMLSlotElement, Node[]>();
  private readonly knownFrames = new WeakSet<Element>();
  private readonly inaccessibleFrames = new Set<Element>();
  private readonly shadows: ShadowDiscovery;

  constructor(
    private readonly document: Document,
    private readonly signal: AbortSignal,
    private readonly onChanges: (records: MutationRecord[]) => void,
    private readonly onListen: (root: SurfaceRoot, signal: AbortSignal) => void,
    private readonly onRoot: (root: SurfaceRoot) => void,
    private readonly onRepair: (nodes: Iterable<Node>, rescan: boolean) => void,
  ) {
    this.shadows = new ShadowDiscovery(signal, root => {
      if (!liveOnPage(root, this.document)) return;
      this.observe(root);
      this.onRoot(root);
    });
    signal.addEventListener('abort', () => this.clear(), { once: true });
  }

  observe(root: SurfaceRoot): void {
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
    this.onListen(root, lifetime.signal);
    if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      root.addEventListener('slotchange', event => {
        const slot = event.target as HTMLSlotElement;
        if (typeof slot?.assignedNodes !== 'function') return;
        this.queueAssigned(slot);
      }, { signal: lifetime.signal });
    }
    this.observers.set(root, lifetime);
  }

  inspect(element: Element): void {
    this.shadows.inspect(element);
    if (isSlot(element) && !this.slots.has(element)) this.slots.set(element, element.assignedNodes());
    if (element.localName === 'iframe' || element.localName === 'frame') {
      if (!this.knownFrames.has(element)) {
        this.knownFrames.add(element);
        element.addEventListener('load', () => {
          this.onRepair([element], false);
          this.discoverFrame(element);
        }, { signal: this.signal });
      }
      this.discoverFrame(element);
    }
  }

  discoverFrame(element: Element): void {
    const nested = frameDocument(element);
    if (!nested) {
      if (eligible(element, this.document)) this.inaccessibleFrames.add(element);
      return;
    }
    this.inaccessibleFrames.delete(element);
    if (!eligible(element, this.document)) return;
    this.observe(nested);
    this.onRoot(nested);
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

  collectInvalidRoots(): SurfaceRoot[] {
    const invalid: SurfaceRoot[] = [];
    for (const [root, observer] of this.observers) {
      if (!liveOnPage(root, this.document)) {
        observer.abort();
        this.observers.delete(root);
        invalid.push(root);
      } else if (!eligible(root, this.document)) {
        invalid.push(root);
      }
    }
    return invalid;
  }

  onElementRepaired(element: Element, live: boolean): void {
    if (!live) {
      this.shadows.forget(element);
      this.inaccessibleFrames.delete(element);
    }
    if (isSlot(element)) this.queueAssigned(element);
  }

  clear(): void {
    for (const observer of this.observers.values()) observer.abort();
    this.observers.clear();
    this.inaccessibleFrames.clear();
  }

  private queueAssigned(slot: HTMLSlotElement): void {
    const current = slot.assignedNodes();
    const affected = new Set([...(this.slots.get(slot) ?? []), ...current]);
    this.slots.set(slot, current);
    if (affected.size) this.onRepair(affected, true);
  }
}

function isSlot(element: Element): element is HTMLSlotElement {
  return element.localName === 'slot' && typeof (element as HTMLSlotElement).assignedNodes === 'function';
}
