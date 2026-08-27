// lib/sync/reviewQueue.ts — where a REFUSED write goes.
//
// Written best-effort, exactly like the change log: failing to record a review item must never turn
// into a failed webhook. But unlike the log, the point of this table is that a human acts on it — a
// refusal that nobody sees is indistinguishable from the silent corruption it was meant to prevent.

import { getDb, hasDatabase, schema } from '../db';
import { sql } from 'drizzle-orm';

export interface ReviewItem {
  kind: string;
  objectType: string;
  recordId: string;
  recordLabel?: string;
  subjectType?: string;
  subjectId?: string;
  subjectLabel?: string;
  reason: string;
  detail?: Record<string, unknown>;
}

/**
 * Record (or re-observe) a refusal. Re-delivery of the same mismatch bumps `seen_count` and
 * refreshes the reason rather than adding a row — a chatty webhook must not bury the queue.
 */
export async function flagForReview(item: ReviewItem): Promise<void> {
  if (!hasDatabase) return;
  try {
    const db = getDb();
    await db.execute(sql`
      INSERT INTO sync_review (kind, object_type, record_id, record_label,
                               subject_type, subject_id, subject_label, reason, detail)
      VALUES (${item.kind}, ${item.objectType}, ${item.recordId}, ${item.recordLabel ?? null},
              ${item.subjectType ?? null}, ${item.subjectId ?? null}, ${item.subjectLabel ?? null},
              ${item.reason}, ${JSON.stringify(item.detail ?? {})}::jsonb)
      ON CONFLICT (kind, record_id, subject_id) DO UPDATE
        SET seen_count = sync_review.seen_count + 1,
            ts = now(),
            reason = EXCLUDED.reason,
            detail = EXCLUDED.detail,
            resolved_at = NULL,
            resolved_note = NULL
    `);
  } catch {
    /* best-effort: never break a sync because the queue is unavailable */
  }
}

export interface OpenReview {
  id: string; ts: string; kind: string; recordId: string; recordLabel: string | null;
  subjectId: string | null; subjectLabel: string | null; reason: string; seenCount: number;
}

/** Open (unresolved) review items, newest first. */
export async function listOpenReviews(limit = 100): Promise<OpenReview[]> {
  if (!hasDatabase) return [];
  const db = getDb();
  const r: any = await db.execute(sql`
    SELECT id, ts, kind, record_id, record_label, subject_id, subject_label, reason, seen_count
    FROM sync_review WHERE resolved_at IS NULL ORDER BY ts DESC LIMIT ${limit}`);
  return ((r as any).rows ?? r).map((x: any) => ({
    id: x.id, ts: x.ts, kind: x.kind, recordId: x.record_id, recordLabel: x.record_label,
    subjectId: x.subject_id, subjectLabel: x.subject_label, reason: x.reason, seenCount: Number(x.seen_count),
  }));
}

/** Count of open items — cheap enough for a hub badge. */
export async function openReviewCount(): Promise<number> {
  if (!hasDatabase) return 0;
  try {
    const db = getDb();
    const r: any = await db.execute(sql`SELECT count(*) AS n FROM sync_review WHERE resolved_at IS NULL`);
    return Number(((r as any).rows ?? r)[0].n);
  } catch { return 0; }
}

export async function resolveReview(id: string, note?: string): Promise<void> {
  if (!hasDatabase) return;
  const db = getDb();
  await db.execute(sql`
    UPDATE sync_review SET resolved_at = now(), resolved_note = ${note ?? null} WHERE id = ${id}::uuid`);
}
