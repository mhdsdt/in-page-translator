import { canTranslate, fieldAllowed, readField, writeField } from './surface';
import type { Field, Target } from './surface';

export interface Patch {
  original: string;
  written: string;
}

export interface Counts {
  seen: number;
  updated: number;
  failed: number;
}

// Tracks translated DOM fields, in-flight attempts, busy retries, and lossless restoration.
export class PatchLedger {
  private readonly patches = new Map<Target, Map<Field, Patch>>();
  private readonly attempted = new WeakMap<Target, Map<Field, string>>();
  private readonly busy = new WeakMap<Target, Set<Field>>();
  readonly counts: Counts = { seen: 0, updated: 0, failed: 0 };

  original(node: Target, field: Field): string | undefined {
    const value = readField(node, field);
    if (value !== null &&
      this.attempted.get(node)?.get(field) !== value &&
      this.patches.get(node)?.get(field)?.written !== value &&
      canTranslate(value)) {
      return value;
    }
  }

  isOwnWrite(node: Target, field: Field): boolean {
    const patch = this.patches.get(node)?.get(field);
    return Boolean(patch && readField(node, field) === patch.written);
  }

  forgetField(node: Target, field: Field): void {
    this.attempted.get(node)?.delete(field);
    this.clearBusy(node, field);
    const fields = this.patches.get(node);
    if (fields) {
      fields.delete(field);
      if (!fields.size) this.patches.delete(node);
    }
  }

  beginAttempt(node: Target, field: Field, original: string): boolean {
    if (this.attempted.get(node)?.get(field) === original) return false;
    let attempts = this.attempted.get(node);
    if (!attempts) {
      attempts = new Map();
      this.attempted.set(node, attempts);
    }
    attempts.set(field, original);
    this.clearBusy(node, field);
    this.counts.seen++;
    return true;
  }

  cancelAttempt(node: Target, field: Field, original: string): void {
    const attempts = this.attempted.get(node);
    if (attempts?.get(field) === original) attempts.delete(field);
    this.counts.seen--;
  }

  recordFailure(node: Target, field: Field, original: string, retryAfterExit: boolean): void {
    this.counts.failed++;
    if (!retryAfterExit) return;
    const attempts = this.attempted.get(node);
    if (attempts?.get(field) === original) attempts.delete(field);
    let deferred = this.busy.get(node);
    if (!deferred) {
      deferred = new Set();
      this.busy.set(node, deferred);
    }
    deferred.add(field);
  }

  applyTranslation(node: Target, field: Field, original: string, written: string): void {
    if (original === written) return;
    let fields = this.patches.get(node);
    if (!fields) {
      fields = new Map();
      this.patches.set(node, fields);
    }
    fields.set(field, { original, written });
    writeField(node, field, written);
    this.counts.updated++;
  }

  repairNode(node: Target, allowed: boolean): void {
    const fields = this.patches.get(node);
    if (fields) {
      for (const [field, patch] of fields) {
        if (allowed && fieldAllowed(node, field)) continue;
        this.undo(node, field, patch);
        fields.delete(field);
        this.attempted.get(node)?.delete(field);
      }
      if (!fields.size) this.patches.delete(node);
    }
    if (!allowed) {
      this.attempted.delete(node);
      for (const field of this.busy.get(node) ?? []) this.clearBusy(node, field);
    }
  }

  async restoreAll(sliceMs: number, yieldToPage: () => Promise<void>): Promise<void> {
    let deadline = performance.now() + sliceMs;
    for (const [node, fields] of this.patches) {
      for (const [field, patch] of fields) this.undo(node, field, patch);
      if (performance.now() >= deadline) {
        await yieldToPage();
        deadline = performance.now() + sliceMs;
      }
    }
    this.patches.clear();
  }

  private clearBusy(node: Target, field: Field): void {
    if (!this.busy.get(node)?.delete(field)) return;
    this.counts.seen--;
    this.counts.failed--;
  }

  private undo(node: Target, field: Field, patch: Patch): void {
    if (readField(node, field) === patch.written) writeField(node, field, patch.original);
  }
}
