import { isElement, isSkippedElement, isText, liveOnPage } from './surface';

const NODES_PER_SLICE = 400;

export class DomScanner {
  private readonly pending = new Set<Node>();
  private cursor?: { root: Node; walker: TreeWalker };

  constructor(
    private readonly document: Document,
    private readonly visit: (node: Node) => void,
  ) {}

  get hasWork(): boolean {
    return Boolean(this.pending.size || this.cursor);
  }

  get active(): boolean {
    return Boolean(this.cursor);
  }

  enqueue(node: Node): void {
    if (isElement(node) || isText(node) || node.nodeType === Node.DOCUMENT_NODE ||
      node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      this.pending.add(node);
    }
  }

  clear(): void {
    this.pending.clear();
    this.cursor = undefined;
  }

  step(deadline: number): boolean {
    if (!this.cursor) {
      const next = this.pending.values().next();
      if (next.done) return false;
      this.pending.delete(next.value);
      this.begin(next.value);
    }
    this.advance(deadline);
    return true;
  }

  private begin(root: Node): void {
    if (!liveOnPage(root, this.document)) return;
    if (isElement(root) && isSkippedElement(root)) return;
    this.visit(root);
    if (isText(root)) return;
    const walker = this.document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      node => (isElement(node) && isSkippedElement(node)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    );
    this.cursor = { root, walker };
  }

  private advance(deadline: number): void {
    const cursor = this.cursor;
    if (!cursor) return;
    if (!liveOnPage(cursor.root, this.document)) {
      this.cursor = undefined;
      return;
    }
    if (!liveOnPage(cursor.walker.currentNode, this.document)) {
      cursor.walker.currentNode = cursor.root;
    }

    for (let visited = 0; visited < NODES_PER_SLICE; visited++) {
      const node = cursor.walker.nextNode();
      if (!node) {
        this.cursor = undefined;
        return;
      }
      this.visit(node);
      if (performance.now() >= deadline) return;
    }
  }
}
