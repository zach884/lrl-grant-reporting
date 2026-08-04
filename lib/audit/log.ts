// lib/audit/log.ts — best-effort sink for the change log.
//
// logChange() persists one change event, tagged with the current run context (runId/trigger). It is
// FULLY best-effort: no DB, an empty change set, or any error => it does nothing and never throws, so
// logging can never break a sync/enrich/score. See docs/sprints/change-log-plan.md.

import { getDb, hasDatabase } from '../db';
import { changeLog } from '../db/schema';
import { currentRun } from './context';
import type { ChangeLogEvent, ChangeLogFieldChange } from './types';

export type { ChangeLogEvent, ChangeLogFieldChange } from './types';

export async function logChange(ev: ChangeLogEvent): Promise<void> {
  if (!hasDatabase) return;
  const hasContent = (ev.changes && ev.changes.length > 0) || Boolean(ev.error);
  if (!hasContent) return; // nothing worth recording (e.g. a no-op sync)
  try {
    const run = currentRun();
    await getDb().insert(changeLog).values({
      app: ev.app ?? 'ghl',
      objectType: ev.objectType,
      recordId: ev.recordId,
      recordLabel: ev.recordLabel ?? null,
      actorKind: ev.actorKind,
      actorName: ev.actorName,
      action: ev.action ?? 'update',
      changes: ev.changes ?? [],
      method: ev.method ?? null,
      confidence: ev.confidence ?? null,
      rationale: ev.rationale ?? null,
      trigger: run?.trigger ?? null,
      runId: run?.runId ?? null,
      applied: ev.applied ?? true,
      error: ev.error ?? null,
    });
  } catch {
    /* best-effort — a change-log failure must never break the write it describes */
  }
}

/**
 * Convenience for the enrichment engines: map applied proposals ({ key, value, provenance }) into a
 * change event and log it. Skips cleanly when nothing was applied.
 */
export async function logEnrichment(opts: {
  objectType: string;
  recordId: string;
  recordLabel?: string;
  actorName: string;
  applied: Array<{ key: string; value: unknown; provenance: { source: string; method: string; confidence: number; rationale?: string } }>;
  applyMode: boolean;
}): Promise<void> {
  if (!opts.applied.length) return;
  const changes: ChangeLogFieldChange[] = opts.applied.map((a) => ({
    field: a.key,
    to: a.value,
    source: a.provenance.source,
    method: a.provenance.method,
    confidence: a.provenance.confidence,
    rationale: a.provenance.rationale,
  }));
  await logChange({
    objectType: opts.objectType,
    recordId: opts.recordId,
    recordLabel: opts.recordLabel,
    actorKind: 'enricher',
    actorName: opts.actorName,
    changes,
    applied: opts.applyMode,
  });
}
