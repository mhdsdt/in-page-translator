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
