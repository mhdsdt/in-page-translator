const HOSTS = new Set([
  'article', 'aside', 'blockquote', 'body', 'div', 'footer', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'header', 'main', 'nav', 'p', 'section', 'span',
]);
const HOSTS_PER_CHECK = 160;
const CHECK_INTERVAL_MS = 500;

// Attaching a new root does not emit a DOM mutation. Check visible candidates
// in small rotating batches rather than patching attachShadow on the page.
export class ShadowDiscovery {
  private readonly watched = new WeakSet<Element>();
  private readonly visible = new Set<Element>();
  private readonly observer: IntersectionObserver;
  private timer?: number;

  constructor(private readonly signal: AbortSignal, private readonly found: (root: ShadowRoot) => void) {
    this.observer = new IntersectionObserver(entries => {
      if (this.signal.aborted) return;
      for (const { target, isIntersecting, boundingClientRect } of entries) {
        if (!this.watched.has(target)) continue;
        // Boxless hosts can render their shadow children without intersecting themselves.
        const boxless = !isIntersecting && !boundingClientRect.width && !boundingClientRect.height &&
          target.ownerDocument.defaultView?.getComputedStyle(target).display === 'contents';
        if (isIntersecting || boxless) this.visible.add(target);
        else this.visible.delete(target);
      }
      this.schedule();
    });
    document.addEventListener('visibilitychange', this.schedule, { signal });
    signal.addEventListener('abort', () => {
      this.observer.disconnect();
      this.visible.clear();
      window.clearTimeout(this.timer);
    }, { once: true });
  }

  inspect(host: Element): void {
    if (host.shadowRoot) {
      this.forget(host);
      this.found(host.shadowRoot);
    } else if (!this.watched.has(host) && host.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
      (HOSTS.has(host.localName) || host.localName.includes('-'))) {
      this.watched.add(host);
      this.observer.observe(host);
    }
  }

  forget(host: Element): void {
    if (!this.watched.delete(host)) return;
    this.visible.delete(host);
    this.observer.unobserve(host);
  }

  private readonly schedule = (): void => {
    if (this.timer !== undefined || !this.visible.size || document.hidden || this.signal.aborted) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      if (document.hidden || this.signal.aborted) return;
      const limit = Math.min(this.visible.size, HOSTS_PER_CHECK);
      for (let index = 0; index < limit; index++) {
        const host = this.visible.values().next().value;
        if (!host) break;
        if (!host.isConnected || host.shadowRoot) {
          this.forget(host);
          if (host.isConnected && host.shadowRoot) this.found(host.shadowRoot);
        } else {
          this.visible.delete(host);
          this.visible.add(host);
        }
      }
      this.schedule();
    }, CHECK_INTERVAL_MS);
  };
}
