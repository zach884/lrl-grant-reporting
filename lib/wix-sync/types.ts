// lib/wix-sync/types.ts — result shapes for the outbound GHL -> Wix sync.

export interface WixFieldChange {
  targetColumn: string;
  from?: unknown;
  to: unknown;
  /** 'value' | 'image' | 'reference' — how the value was produced. */
  via: 'value' | 'image' | 'reference';
}

export interface WixSyncResult {
  /** The source record id. */
  sourceId: string;
  /** The upserted Wix item id (undefined on dry-run insert or when source missing). */
  itemId?: string;
  action: 'insert' | 'patch' | 'noop' | 'skip';
  /** Fields that changed (or would change on dry-run). */
  written: WixFieldChange[];
  /** Fields equal to the current Wix value (idempotent). */
  unchanged: number;
  /** Fields skipped, with reasons (empty value, unwritable, unresolved reference, …). */
  skipped: Array<{ targetColumn: string; reason: string }>;
  dryRun: boolean;
  note?: string;
}
