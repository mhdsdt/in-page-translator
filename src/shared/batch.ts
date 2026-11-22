export interface BatchLimits {
  maxItems: number;
  maxChars: number;
}

// Split items into contiguous character-budgeted batches without reordering.
export function packBatches<T>(
  items: readonly T[],
  textLength: (item: T) => number,
  { maxItems, maxChars }: BatchLimits,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let chars = 0;

  for (const item of items) {
    const length = textLength(item);
    if (current.length >= maxItems || (current.length > 0 && chars + length > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += length;
  }
  if (current.length) batches.push(current);
  return batches;
}

// Take a prefix batch from a FIFO queue that shares the leading group key and fits the budget.
export function takePrefixBatch<T>(
  queue: readonly T[],
  sameGroup: (item: T) => boolean,
  textLength: (item: T) => number,
  { maxItems, maxChars }: BatchLimits,
): T[] {
  const batch: T[] = [];
  let chars = 0;
  for (const item of queue) {
    if (!sameGroup(item)) break;
    if (batch.length >= maxItems) break;
    const length = textLength(item);
    if (batch.length > 0 && chars + length > maxChars) break;
    batch.push(item);
    chars += length;
  }
  return batch;
}

export interface BucketedBatchOptions {
  preferShort?: boolean;
  preferLong?: boolean;
  scanLimit?: number;
}

interface BucketEntry<T> {
  index: number;
  item: T;
  length: number;
  bucket: 'short' | 'medium' | 'long';
}

const SHORT_MAX_CHARS = 40;
const MEDIUM_MAX_CHARS = 120;
const DEFAULT_SCAN_LIMIT = 96;

// Group queued items by similar length to minimize NMT sequence padding and head-of-line blocking.
export function takeBucketedBatch<T>(
  queue: T[],
  sameGroup: (item: T) => boolean,
  textLength: (item: T) => number,
  options: BucketedBatchOptions = {},
): T[] {
  const scanCap = Math.min(queue.length, options.scanLimit ?? DEFAULT_SCAN_LIMIT);
  const short: BucketEntry<T>[] = [];
  const medium: BucketEntry<T>[] = [];
  const long: BucketEntry<T>[] = [];
  let head: BucketEntry<T> | undefined;

  for (let index = 0; index < scanCap; index++) {
    const item = queue[index]!;
    if (!sameGroup(item)) break;
    const length = textLength(item);
    const bucket = length <= SHORT_MAX_CHARS ? 'short' : length <= MEDIUM_MAX_CHARS ? 'medium' : 'long';
    const entry: BucketEntry<T> = { index, item, length, bucket };
    head ??= entry;
    if (bucket === 'short') short.push(entry);
    else if (bucket === 'medium') medium.push(entry);
    else long.push(entry);
  }

  if (!head) return [];

  let chosen: BucketEntry<T>[];
  let bucketKind: BucketEntry<T>['bucket'];
  if (options.preferShort && short.length > 0) {
    bucketKind = 'short';
    chosen = short.sort((a, b) => a.length - b.length || a.index - b.index);
  } else if (options.preferLong && long.length > 0) {
    bucketKind = 'long';
    chosen = long.sort((a, b) => b.length - a.length || a.index - b.index);
  } else {
    bucketKind = head.bucket;
    const pool = bucketKind === 'short' ? short : bucketKind === 'medium' ? medium : long;
    const headLen = head.length;
    chosen = pool.sort((a, b) =>
      Math.abs(a.length - headLen) - Math.abs(b.length - headLen) || a.index - b.index,
    );
  }

  const limits: BatchLimits = bucketKind === 'short'
    ? { maxItems: options.preferShort ? 8 : 10, maxChars: options.preferShort ? 320 : 360 }
    : bucketKind === 'medium'
      ? { maxItems: 6, maxChars: 600 }
      : { maxItems: 4, maxChars: 900 };

  const selected: BucketEntry<T>[] = [];
  let chars = 0;
  for (const entry of chosen) {
    if (selected.length >= limits.maxItems) break;
    if (selected.length > 0 && chars + entry.length > limits.maxChars) break;
    selected.push(entry);
    chars += entry.length;
  }

  selected
    .slice()
    .sort((a, b) => b.index - a.index)
    .forEach(entry => { queue.splice(entry.index, 1); });

  return selected
    .sort((a, b) => bucketKind === 'long'
      ? b.length - a.length || a.index - b.index
      : a.length - b.length || a.index - b.index)
    .map(entry => entry.item);
}
