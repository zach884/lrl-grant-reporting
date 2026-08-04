// lib/sync/convergenceGuard.ts — runtime guard against non-converging sync writes (loop prevention).
//
// The country loop taught us the failure mode: the engine proposes value P for a field, writes it, but
// the field stores a DIFFERENT canonical form (GHL normalized the country scalar "United States" → "US"),
// so the next sync sees a diff and re-proposes P — forever, fanned across every contact on the company.
//
// The guard keeps a ledger of the last value we WROTE to each (record, field). When a change re-proposes
// a value we already wrote, yet the field's current value isn't that value (it didn't stick), the write
// is non-converging → we SUPPRESS it (skip + log) instead of churning. Legitimate NEW values (different
// from what we last wrote) still flow. Fully best-effort: no DB / any error → guard is a transparent
// no-op, never blocking a real sync.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb, hasDatabase } from '../db';
import { syncWriteLedger } from '../db/schema';

export interface GuardChange { fieldKey: string; from: unknown; to: unknown }

/** Normalize a value to a comparable key (arrays order-insensitive; scalars trimmed + lowercased). */
export function valueKey(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x).trim().toLowerCase()).sort().join('|');
  if (v == null) return '';
  return String(v).trim().toLowerCase();
}

/**
 * Pure decision: suppress this change as non-converging? True when we already wrote `to` before
 * (`lastWritten` matches it) yet the field's current value (`from`) isn't `to` — i.e. our last write
 * didn't stick, so writing it again would just loop. A change to a genuinely new value is never suppressed.
 */
export function shouldSuppress(change: GuardChange, lastWritten: string | null | undefined): boolean {
  if (lastWritten == null) return false;
  const toKey = valueKey(change.to);
  return lastWritten === toKey && valueKey(change.from) !== toKey;
}

export interface GuardResult {
  keep: GuardChange[];
  suppressed: Array<{ key: string; reason: string }>;
}

/** Filter out non-converging changes for a target record, using the write ledger. */
export async function guardChanges(recordId: string, changes: GuardChange[]): Promise<GuardResult> {
  if (!hasDatabase || changes.length === 0) return { keep: changes, suppressed: [] };
  let ledger = new Map<string, string>();
  try {
    const rows = await getDb()
      .select()
      .from(syncWriteLedger)
      .where(and(eq(syncWriteLedger.recordId, recordId), inArray(syncWriteLedger.fieldKey, changes.map((c) => c.fieldKey))));
    ledger = new Map(rows.map((r) => [r.fieldKey, r.lastValue ?? '']));
  } catch {
    return { keep: changes, suppressed: [] }; // guard unavailable → don't block the sync
  }
  const keep: GuardChange[] = [];
  const suppressed: GuardResult['suppressed'] = [];
  for (const c of changes) {
    if (shouldSuppress(c, ledger.get(c.fieldKey))) {
      suppressed.push({ key: c.fieldKey, reason: `non-converging: last wrote ${JSON.stringify(c.to)} but field is ${JSON.stringify(c.from)} — suppressed (check mapping transform/options)` });
      console.warn(`[convergence-guard] suppressed non-converging write ${recordId}.${c.fieldKey}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
    } else {
      keep.push(c);
    }
  }
  return { keep, suppressed };
}

/** Record what we just wrote (one upsert for all fields), so future re-proposes can be caught. */
export async function recordLedger(recordId: string, written: Array<{ fieldKey: string; value: unknown }>): Promise<void> {
  if (!hasDatabase || written.length === 0) return;
  try {
    const now = new Date();
    await getDb()
      .insert(syncWriteLedger)
      .values(written.map((w) => ({ recordId, fieldKey: w.fieldKey, lastValue: valueKey(w.value), updatedAt: now })))
      .onConflictDoUpdate({
        target: [syncWriteLedger.recordId, syncWriteLedger.fieldKey],
        set: { lastValue: sql`excluded.last_value`, updatedAt: sql`excluded.updated_at` },
      });
  } catch {
    /* best-effort — a ledger write failure must never break the sync */
  }
}
