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
  private readonly ranges = new WeakMap<Document, Range>();
  private styleTimer?: number;
  private deferredFrame: number | undefined;
  private hiddenFrame: number | undefined;

  constructor(
    private readonly signal: AbortSignal,
    private readonly onSeen: (target: Target) => void,
  ) {
    this.observer = new IntersectionObserver(entries => this.onIntersection(entries));
    window.addEventListener('resize', this.refresh, { signal });
    document.addEventListener('visibilitychange', () => {
      this.refresh();
      this.refreshHidden();
      this.scheduleStyleCheck();
    }, { signal });
    signal.addEventListener('abort', () => {
      this.observer.disconnect();
      this.targets.clear();
      this.deferred.clear();
      this.hidden.clear();
      window.clearTimeout(this.styleTimer);
      if (this.deferredFrame !== undefined) window.cancelAnimationFrame(this.deferredFrame);
      if (this.hiddenFrame !== undefined) window.cancelAnimationFrame(this.hiddenFrame);
    }, { once: true });
  }

  listen(root: SurfaceRoot, signal: AbortSignal): void {
    root.addEventListener('scroll', this.refresh, { capture: true, passive: true, signal });
    for (const event of ['focusin', 'focusout', 'animationend', 'transitionend']) {
      root.addEventListener(event, this.refreshAll, { capture: true, passive: true, signal });
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
    if (this.signal.aborted || this.deferredFrame !== undefined || !this.deferred.size) return;
    this.deferredFrame = window.requestAnimationFrame(() => {
      this.deferredFrame = undefined;
      for (const element of this.deferred) this.reobserve(element);
    });
  };

  readonly refreshHidden = (): void => {
    if (this.signal.aborted || this.hiddenFrame !== undefined || !this.hidden.size) return;
    this.hiddenFrame = window.requestAnimationFrame(() => {
      this.hiddenFrame = undefined;
      const limit = Math.min(this.hidden.size, STYLE_CHECK_LIMIT);
      for (let index = 0; index < limit; index++) {
        const element = this.hidden.values().next().value;
        if (!element) break;
        this.hidden.delete(element);
        this.hidden.add(element);
        this.reobserve(element);
      }
    });
  };

  private readonly refreshAll = (): void => {
    this.refresh();
    this.refreshHidden();
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

  private reparent(group: Set<Target>, parent: Element): void {
    for (const target of [...group]) {
      const afterExit = this.waitForExit.has(target);
      this.forget(target);
      if (afterExit) this.waitForExit.add(target);
      this.add(target, parent);
    }
  }

  private onIntersection(entries: IntersectionObserverEntry[]): void {
    if (this.signal.aborted) return;
    const frames = new Map<Document, boolean>();
    const styles = new Map<Element, CSSStyleDeclaration | null>();
    for (const entry of entries) {
      const element = entry.target;
      const group = this.targets.get(element);
      if (!group) continue;
      this.deferred.delete(element);
      this.hidden.delete(element);

      const box = entry.boundingClientRect;
      if (!box.width || !box.height) {
        const style = styleOf(element, styles);
        if (style?.display === 'contents' ||
          (style && overflowsVisibly(style) && style.opacity !== '0' && this.hasVisibleTextRect(group))) {
          const parent = composedElementParent(element);
          if (parent && parent !== element) {
            this.reparent(group, parent);
            continue;
          }
        }
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
      let unclippedOverflow: boolean | undefined;
      let hasDeferred = false;

      for (const target of [...group]) {
        const owner = isText(target) ? composedElementParent(target) : target;
        const ownerStyle = owner ? styleOf(owner, styles) : null;
        const styleVisible = rendered && ownerStyle?.visibility === 'visible';
        if (!styleVisible) {
          this.hidden.add(element);
          this.waitForExit.delete(target);
          continue;
        }
        if (isText(target) && !this.textVisible(target, clip, () => {
          unclippedOverflow ??= entry.intersectionRatio >= 0.999 && overflowsVisibly(styleOf(element, styles));
          return unclippedOverflow;
        })) {
          this.waitForExit.delete(target);
          hasDeferred = true;
          continue;
        }
        if (this.waitForExit.has(target)) {
          hasDeferred = true;
          continue;
        }
        this.forget(target);
        this.onSeen(target);
      }
      if (hasDeferred && group.size) this.deferred.add(element);
    }
    this.scheduleStyleCheck();
  }

  private hasVisibleTextRect(group: Set<Target>): boolean {
    for (const target of group) {
      if (!isText(target)) continue;
      const rects = this.clientRects(target);
      for (let i = 0; i < rects.length; i++) {
        const rect = rects[i]!;
        if (rect.width > 0 && rect.height > 0) return true;
      }
    }
    return false;
  }

  private textVisible(
    text: Text,
    clip: DOMRectReadOnly,
    allowOverflow: () => boolean,
  ): boolean {
    const rects = this.clientRects(text);
    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i]!;
      if (rect.width > 0 && rect.height > 0 &&
        rect.left < clip.right && rect.right > clip.left &&
        rect.top < clip.bottom && rect.bottom > clip.top) {
        return true;
      }
    }
    if (!allowOverflow()) return false;
    const view = text.ownerDocument.defaultView;
    if (!view) return false;
    const right = view.innerWidth;
    const bottom = view.innerHeight;
    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i]!;
      if (rect.width > 0 && rect.height > 0 &&
        rect.left < right && rect.right > 0 &&
        rect.top < bottom && rect.bottom > 0) {
        return true;
      }
    }
    return false;
  }

  private clientRects(text: Text): DOMRectList {
    const doc = text.ownerDocument;
    let range = this.ranges.get(doc);
    if (!range) {
      range = doc.createRange();
      this.ranges.set(doc, range);
    }
    range.selectNodeContents(text);
    const rects = range.getClientRects();
    range.setStart(doc, 0);
    range.collapse(true);
    return rects;
  }
}

function styleOf(element: Element, cache: Map<Element, CSSStyleDeclaration | null>): CSSStyleDeclaration | null {
  const known = cache.get(element);
  if (known !== undefined) return known;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element) ?? null;
  cache.set(element, style);
  return style;
}

function overflowsVisibly(style: CSSStyleDeclaration | null): boolean {
  return Boolean(style && style.overflowX === 'visible' && style.overflowY === 'visible');
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
