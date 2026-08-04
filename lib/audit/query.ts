// lib/audit/query.ts — read helpers for the change log (the Activity page + CSV export).

import { and, or, eq, gte, desc, ilike, sql } from 'drizzle-orm';
import { getDb, hasDatabase } from '../db';
import { changeLog, type ChangeLogRow } from '../db/schema';

export interface ChangeLogFilter {
  q?: string;
  actorKind?: string;
  actorName?: string;
  app?: string;
  /** 'all' | 'applied' | 'dryrun' */
  applied?: string;
  recordId?: string;
  runId?: string;
  /** ISO timestamp lower bound. */
  since?: string;
  limit?: number;
  offset?: number;
}

function conditions(f: ChangeLogFilter) {
  const conds = [] as any[];
  if (f.actorKind) conds.push(eq(changeLog.actorKind, f.actorKind));
  if (f.actorName) conds.push(eq(changeLog.actorName, f.actorName));
  if (f.app) conds.push(eq(changeLog.app, f.app));
  if (f.applied === 'applied') conds.push(eq(changeLog.applied, true));
  if (f.applied === 'dryrun') conds.push(eq(changeLog.applied, false));
  if (f.recordId) conds.push(eq(changeLog.recordId, f.recordId));
  if (f.runId) conds.push(eq(changeLog.runId, f.runId));
  if (f.since) { const d = new Date(f.since); if (!Number.isNaN(d.getTime())) conds.push(gte(changeLog.ts, d)); }
  if (f.q && f.q.trim()) {
    const like = `%${f.q.trim()}%`;
    conds.push(or(
      ilike(changeLog.recordLabel, like),
      ilike(changeLog.recordId, like),
      ilike(changeLog.actorName, like),
      ilike(changeLog.rationale, like),
      sql`${changeLog.changes}::text ILIKE ${like}`,
    ));
  }
  return conds.length ? and(...conds) : undefined;
}

/** Filtered, paginated page of change-log rows (newest first). Returns hasMore for pagination. */
export async function queryChangeLog(f: ChangeLogFilter): Promise<{ rows: ChangeLogRow[]; hasMore: boolean }> {
  if (!hasDatabase) return { rows: [], hasMore: false };
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
  const offset = Math.max(f.offset ?? 0, 0);
  const rows = await getDb()
    .select()
    .from(changeLog)
    .where(conditions(f))
    .orderBy(desc(changeLog.ts))
    .limit(limit + 1)
    .offset(offset);
  const hasMore = rows.length > limit;
  return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

/** Distinct actor names (+ kind) for the filter dropdown. */
export async function distinctActors(): Promise<Array<{ name: string; kind: string }>> {
  if (!hasDatabase) return [];
  try {
    return await getDb().selectDistinct({ name: changeLog.actorName, kind: changeLog.actorKind }).from(changeLog).orderBy(changeLog.actorName);
  } catch {
    return [];
  }
}
