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

/** How far back the oscillation rules look. Loops run in seconds; real corrections do not. */
export const OSCILLATION_WINDOW_MS = 10 * 60 * 1000;
/** Writes to ONE field inside the window before the rate breaker trips. */
export const MAX_WRITES_IN_WINDOW = 4;
/** How many past values to keep per (record, field). Bounded — this is a hot-path column. */
export const RECENT_LIMIT = 6;

export interface RecentWrite { v: string; t: number }

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

/** Why a change was held back — the caller escalates 'oscillation' to the review queue. */
export type SuppressKind = 'non-converging' | 'oscillation' | 'rate';

export interface SuppressDecision { kind: SuppressKind; reason: string }

/**
 * Pure decision: do the recent writes to this field say we are in a loop?
 *
 * Returns null to allow. Checked AFTER `shouldSuppress`, and only reached for changes that `diff`
 * already judged to be real (current value ≠ proposed), which is what makes "we wrote this value
 * moments ago" meaningful rather than merely idempotent.
 */
export function shouldSuppressOscillation(
  change: GuardChange,
  recent: RecentWrite[] | null | undefined,
  now: number,
  opts: { windowMs?: number; maxWrites?: number } = {},
): SuppressDecision | null {
  if (!recent || recent.length === 0) return null;
  const windowMs = opts.windowMs ?? OSCILLATION_WINDOW_MS;
  const maxWrites = opts.maxWrites ?? MAX_WRITES_IN_WINDOW;
  const inWindow = recent.filter((r) => now - r.t <= windowMs);
  if (inWindow.length === 0) return null;

  const toKey = valueKey(change.to);
  const repeat = inWindow.find((r) => r.v === toKey);
  if (repeat) {
    const secs = Math.round((now - repeat.t) / 1000);
    return {
      kind: 'oscillation',
      reason: `oscillating: we wrote ${JSON.stringify(change.to)} to this field ${secs}s ago and it has since changed to ${JSON.stringify(change.from)} — suppressed (this field is almost certainly mapped in both directions)`,
    };
  }
  if (inWindow.length >= maxWrites) {
    return {
      kind: 'rate',
      reason: `churning: ${inWindow.length} writes to this field in the last ${Math.round(windowMs / 60000)}m — suppressed pending review`,
    };
  }
  return null;
}

export interface GuardResult {
  keep: GuardChange[];
  suppressed: Array<{ key: string; reason: string; kind?: SuppressKind }>;
  /** Fields held back by an oscillation/rate rule — a config fault a human should see. */
  loops: Array<{ fieldKey: string; kind: SuppressKind; reason: string; from: unknown; to: unknown }>;
}

/** Filter out non-converging and oscillating changes for a target record, using the write ledger. */
export async function guardChanges(recordId: string, changes: GuardChange[], now = Date.now()): Promise<GuardResult> {
  if (!hasDatabase || changes.length === 0) return { keep: changes, suppressed: [], loops: [] };
  let lastValues = new Map<string, string>();
  let recents = new Map<string, RecentWrite[]>();
  try {
    const rows = await getDb()
      .select()
      .from(syncWriteLedger)
      .where(and(eq(syncWriteLedger.recordId, recordId), inArray(syncWriteLedger.fieldKey, changes.map((c) => c.fieldKey))));
    lastValues = new Map(rows.map((r) => [r.fieldKey, r.lastValue ?? '']));
    recents = new Map(rows.map((r) => [r.fieldKey, r.recent ?? []]));
  } catch {
    return { keep: changes, suppressed: [], loops: [] }; // guard unavailable → don't block the sync
  }
  const keep: GuardChange[] = [];
  const suppressed: GuardResult['suppressed'] = [];
  const loops: GuardResult['loops'] = [];
  for (const c of changes) {
    if (shouldSuppress(c, lastValues.get(c.fieldKey))) {
      suppressed.push({ key: c.fieldKey, kind: 'non-converging', reason: `non-converging: last wrote ${JSON.stringify(c.to)} but field is ${JSON.stringify(c.from)} — suppressed (check mapping transform/options)` });
      console.warn(`[convergence-guard] suppressed non-converging write ${recordId}.${c.fieldKey}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
      continue;
    }
    const osc = shouldSuppressOscillation(c, recents.get(c.fieldKey), now);
    if (osc) {
      suppressed.push({ key: c.fieldKey, kind: osc.kind, reason: osc.reason });
      loops.push({ fieldKey: c.fieldKey, kind: osc.kind, reason: osc.reason, from: c.from, to: c.to });
      console.warn(`[convergence-guard] ${osc.kind} ${recordId}.${c.fieldKey}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
      continue;
    }
    keep.push(c);
  }
  return { keep, suppressed, loops };
}

/** Append a write to a bounded, newest-first history. Pure, so the trimming rule is testable. */
export function appendRecent(
  prior: RecentWrite[] | null | undefined,
  value: unknown,
  now: number,
  limit = RECENT_LIMIT,
): RecentWrite[] {
  return [{ v: valueKey(value), t: now }, ...(prior ?? [])].slice(0, limit);
}

/**
 * Record what we just wrote, so future re-proposes can be caught.
 *
 * `recent` is appended in SQL rather than read-modify-written, so two concurrent webhooks racing on
 * the same field cannot lose each other's entry — which matters most during exactly the storm this
 * guard exists to stop.
 */
export async function recordLedger(recordId: string, written: Array<{ fieldKey: string; value: unknown }>, now = Date.now()): Promise<void> {
  if (!hasDatabase || written.length === 0) return;
  try {
    const ts = new Date(now);
    await getDb()
      .insert(syncWriteLedger)
      .values(written.map((w) => ({
        recordId, fieldKey: w.fieldKey, lastValue: valueKey(w.value),
        recent: [{ v: valueKey(w.value), t: now }], updatedAt: ts,
      })))
      .onConflictDoUpdate({
        target: [syncWriteLedger.recordId, syncWriteLedger.fieldKey],
        set: {
          lastValue: sql`excluded.last_value`,
          updatedAt: sql`excluded.updated_at`,
          recent: sql`(
            SELECT jsonb_agg(e ORDER BY (e->>'t')::bigint DESC)
            FROM (
              SELECT e FROM jsonb_array_elements(excluded.recent || COALESCE(${syncWriteLedger.recent}, '[]'::jsonb)) e
              ORDER BY (e->>'t')::bigint DESC
              LIMIT ${RECENT_LIMIT}
            ) t(e)
          )`,
        },
      });
  } catch {
    /* best-effort — a ledger write failure must never break the sync */
  }
}
