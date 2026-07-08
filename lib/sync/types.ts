// lib/sync/types.ts — sync engine shapes.

export interface DesiredContactState {
  /** contactKey -> value to write (pre-coercion, in "contact input" form). */
  customInputs: Record<string, unknown>;
  /** legacy free-text Company Name box, if the map syncs it. */
  companyName?: string;
}

export interface ContactSyncResult {
  contactId: string;
  /** field keys/ids actually written (changed). */
  written: string[];
  /** whether companyName was rewritten. */
  companyNameWritten: boolean;
  /** fields that matched already (equality-guarded, no write). */
  unchanged: number;
  /** inputs that couldn't be coerced (unknown option, missing field, ...). */
  skipped: Array<{ key: string; value: unknown; reason: string }>;
  /** per-field before/after, for the drift log. */
  drift: Array<{ field: string; from: unknown; to: unknown }>;
  applied: boolean;
}

export interface CompanySyncResult {
  companyId: string;
  companyName?: string;
  contactCount: number;
  results: ContactSyncResult[];
}

export interface ReconcileStats {
  companiesProcessed: number;
  contactsProcessed: number;
  contactsChanged: number;
  fieldsWritten: number;
  errors: Array<{ companyId?: string; contactId?: string; message: string }>;
}
