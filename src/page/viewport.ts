import { composedElementParent, isText } from './surface';
import type { SurfaceRoot, Target } from './surface';

const STYLE_CHECK_MS = 300;
const STYLE_CHECK_LIMIT = 96;
const boxVisibility = { opacityProperty: true, contentVisibilityAuto: true };
const fullVisibility = { ...boxVisibility, visibilityProperty: true };

// The browser computes clipping through nested scrollers and same-origin frames.
export class Viewport {
  private readonly targets = new Map<Element, Set<Target>>();
  private readonly owners = new WeakMap<Target, Element>();
  private readonly deferred = new Set<Element>();
  private readonly observer: IntersectionObserver;
  private readonly hidden = new Set<Element>();
  private readonly waitForExit = new WeakSet<Target>();
  private styleTimer?: number;
  private frame: number | undefined;

  constructor(
    private readonly signal: AbortSignal,
    private readonly onSeen: (target: Target) => void,
  ) {
    this.observer = new IntersectionObserver(entries => this.onIntersection(entries));
    window.addEventListener('resize', this.refresh, { signal });
    document.addEventListener('visibilitychange', () => {
      this.refresh();
      this.scheduleStyleCheck();
    }, { signal });
    signal.addEventListener('abort', () => {
      this.observer.disconnect();
      this.targets.clear();
      this.deferred.clear();
      this.hidden.clear();
      window.clearTimeout(this.styleTimer);
      if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
    }, { once: true });
  }

  listen(root: SurfaceRoot, signal: AbortSignal): void {
    for (const event of ['scroll', 'focusin', 'focusout', 'animationend', 'transitionend']) {
      root.addEventListener(event, this.refresh, { capture: true, passive: true, signal });
    }
  }

  observe(target: Target, afterExit = false): void {
    if (this.owners.has(target)) return;
    const element = isText(target) ? composedElementParent(target) : target;
    if (afterExit) this.waitForExit.add(target);
    if (element) this.add(target, element);
  }

  forget(target: Target): void {
    const element = this.owners.get(target);
    if (!element) return;
    this.owners.delete(target);
    this.waitForExit.delete(target);
    const group = this.targets.get(element);
    group?.delete(target);
    if (group?.size) return;
    this.targets.delete(element);
    this.deferred.delete(element);
    this.hidden.delete(element);
    this.observer.unobserve(element);
  }

  // A tall parent can stay in view while different text inside it scrolls past.
  // Get fresh clipping rectangles only for intersecting parents with unseen text.
  readonly refresh = (): void => {
    if (this.signal.aborted || this.frame !== undefined || !this.deferred.size) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = undefined;
      for (const element of this.deferred) this.reobserve(element);
    });
  };

  private reobserve(element: Element): void {
    this.observer.unobserve(element);
    this.observer.observe(element);
  }

  private scheduleStyleCheck(): void {
    if (!this.hidden.size || this.styleTimer !== undefined || document.hidden || this.signal.aborted) return;
    this.styleTimer = window.setTimeout(() => {
      this.styleTimer = undefined;
      if (document.hidden || this.signal.aborted) return;
      const limit = Math.min(this.hidden.size, STYLE_CHECK_LIMIT);
      for (let index = 0; index < limit; index++) {
        const element = this.hidden.values().next().value;
        if (!element) break;
        this.hidden.delete(element);
        this.hidden.add(element);
        this.reobserve(element);
      }
      this.scheduleStyleCheck();
    }, STYLE_CHECK_MS);
  }

  private add(target: Target, element: Element): void {
    this.owners.set(target, element);
    let group = this.targets.get(element);
    if (!group) {
      group = new Set();
      this.targets.set(element, group);
      this.observer.observe(element);
    } else {
      // Its last observation may already have been delivered.
      this.deferred.add(element);
      this.refresh();
    }
    group.add(target);
  }

  private onIntersection(entries: IntersectionObserverEntry[]): void {
    if (this.signal.aborted) return;
    const frames = new Map<Document, boolean>();
    for (const entry of entries) {
      const element = entry.target;
      const group = this.targets.get(element);
      if (!group) continue;
      this.deferred.delete(element);
      this.hidden.delete(element);

      if (!entry.boundingClientRect.width && !entry.boundingClientRect.height &&
        element.ownerDocument.defaultView?.getComputedStyle(element).display === 'contents') {
        const parent = composedElementParent(element);
        if (parent) {
          for (const target of group) {
            const afterExit = this.waitForExit.has(target);
            this.forget(target);
            if (afterExit) this.waitForExit.add(target);
            this.add(target, parent);
          }
        }
        continue;
      }

      const clip = entry.intersectionRect;
      if (!entry.isIntersecting) {
        for (const target of group) this.waitForExit.delete(target);
        continue;
      }
      if (document.hidden || !clip.width || !clip.height) {
        this.deferred.add(element);
        if (!document.hidden) {
          for (const target of group) this.waitForExit.delete(target);
        }
        continue;
      }

      const rendered = element.checkVisibility(boxVisibility) && visibleFrames(element.ownerDocument, frames);
      for (const target of group) {
        const owner = isText(target) ? composedElementParent(target) : target;
        const styleVisible = rendered && owner?.ownerDocument.defaultView?.getComputedStyle(owner).visibility === 'visible';
        if (!styleVisible) {
          this.hidden.add(element);
          this.waitForExit.delete(target);
          continue;
        }
        if (isText(target) && !textIntersects(target, clip)) {
          this.waitForExit.delete(target);
          continue;
        }
        if (this.waitForExit.has(target)) continue;
        this.forget(target);
        this.onSeen(target);
      }
      if (group.size) this.deferred.add(element);
    }
    this.scheduleStyleCheck();
  }
}

function visibleFrames(doc: Document, cache: Map<Document, boolean>): boolean {
  if (doc === document) return true;
  const known = cache.get(doc);
  if (known !== undefined) return known;
  const frame = doc.defaultView?.frameElement;
  const visible = Boolean(frame && frame.checkVisibility(fullVisibility) && visibleFrames(frame.ownerDocument, cache));
  cache.set(doc, visible);
  return visible;
}

function textIntersects(text: Text, clip: DOMRectReadOnly): boolean {
  const range = text.ownerDocument.createRange();
  range.selectNodeContents(text);
  return Array.from(range.getClientRects()).some(rect =>
    rect.width > 0 && rect.height > 0 &&
    rect.left < clip.right && rect.right > clip.left &&
    rect.top < clip.bottom && rect.bottom > clip.top,
  );
}
