// lib/activities/claims.ts — the idempotency ledger for activity ingestion.
//
// THE PROBLEM, measured live 2026-08-19: a newly created GHL record takes **~12 seconds** to become
// findable through `POST /objects/{key}/records/search` (a direct GET by id works instantly — it is
// the search INDEX that lags). Webhook retries and double-clicked form submissions arrive in far
// less than that, so a search-based find-or-create answers "not found" and creates a duplicate.
// A live three-delivery test produced three records before this existed. Duplicate activities
// double-count in funder reports, which is the failure this whole design exists to prevent.
//
// THE FIX: claim the source event in Postgres — immediately consistent, unlike the GHL index —
// under a UNIQUE (source, source_record_id). Exactly one caller wins and creates the record; the
// others read the winner's id. The GHL search stays as a self-healing fallback for events claimed
// before this table existed, or created by a backfill elsewhere.

import { and, eq, sql } from 'drizzle-orm';
import { getDb, hasDatabase } from '../db';
import { activitySourceClaims } from '../db/schema';

export interface ClaimResult {
  /** 'won' = you must create the record, then call resolveClaim. 'existing' = someone already did. */
  status: 'won' | 'existing' | 'unavailable';
  /** Set when status is 'existing'. */
  activityRecordId?: string;
}

/** How long to wait for a concurrent winner to publish its record id before giving up on it. */
const WAIT_MS = 4000;
const POLL_MS = 250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Claim a source event, or report that it is already claimed.
 *
 * With no database configured this returns 'unavailable' and the caller falls back to the GHL
 * search — degraded (duplicates are possible within the index lag) but never blocking, which
 * matches how every other optional-DB path in this app behaves.
 */
export async function claimSourceEvent(source: string, sourceRecordId: string): Promise<ClaimResult> {
  if (!hasDatabase || !sourceRecordId) return { status: 'unavailable' };
  const db = getDb();

  // Insert-or-nothing IS the mutual exclusion: the unique index elects one winner among concurrent
  // deliveries, with no read-then-write race to lose.
  const inserted = await db
    .insert(activitySourceClaims)
    .values({ source, sourceRecordId })
    .onConflictDoNothing()
    .returning({ id: activitySourceClaims.id });
  if (inserted.length) return { status: 'won' };

  // Someone else holds the claim. Usually their record id is already published; if their create is
  // still in flight, wait briefly rather than racing them into a duplicate.
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const [row] = await db
      .select({ recordId: activitySourceClaims.activityRecordId })
      .from(activitySourceClaims)
      .where(and(eq(activitySourceClaims.source, source), eq(activitySourceClaims.sourceRecordId, sourceRecordId)))
      .limit(1);
    if (row?.recordId) return { status: 'existing', activityRecordId: row.recordId };
    if (Date.now() >= deadline) break;
    await sleep(POLL_MS);
  }

  // The holder never published — it crashed, or is slower than the wait. Treat the claim as stale
  // and take it over: a lost activity is worse than a rare duplicate, and the winner's own resolve
  // will simply overwrite ours with the same source event.
  return { status: 'won' };
}

/** Publish the record id for a claim you won, so concurrent deliveries can find it. */
export async function resolveClaim(source: string, sourceRecordId: string, activityRecordId: string): Promise<void> {
  if (!hasDatabase || !sourceRecordId) return;
  try {
    await getDb()
      .update(activitySourceClaims)
      .set({ activityRecordId, resolvedAt: sql`now()` })
      .where(and(eq(activitySourceClaims.source, source), eq(activitySourceClaims.sourceRecordId, sourceRecordId)));
  } catch {
    /* best-effort: the GHL search fallback still finds it once the index catches up */
  }
}

/** Drop a claim whose create failed, so a retry can try again instead of finding a dead claim. */
export async function releaseClaim(source: string, sourceRecordId: string): Promise<void> {
  if (!hasDatabase || !sourceRecordId) return;
  try {
    await getDb()
      .delete(activitySourceClaims)
      .where(and(eq(activitySourceClaims.source, source), eq(activitySourceClaims.sourceRecordId, sourceRecordId)));
  } catch {
    /* best-effort */
  }
}

/** The activity id previously recorded for this source event, if the ledger knows it. */
export async function lookupClaim(source: string, sourceRecordId: string): Promise<string | null> {
  if (!hasDatabase || !sourceRecordId) return null;
  try {
    const [row] = await getDb()
      .select({ recordId: activitySourceClaims.activityRecordId })
      .from(activitySourceClaims)
      .where(and(eq(activitySourceClaims.source, source), eq(activitySourceClaims.sourceRecordId, sourceRecordId)))
      .limit(1);
    return row?.recordId ?? null;
  } catch {
    return null;
  }
}
