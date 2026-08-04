// lib/stage/propagateScoring.ts — push a just-written stage record's scores UP to the company.
//
// After the scorer writes/updates a `custom_objects.business_stage` record, the company's
// `*_current` fields (trl_current, mrl_current, crl_current, churchill_current,
// churchill_substage_current, latest_tech_stage_rationale) should reflect the latest scores so the
// company record — and the reports/embeds that read it — show current numbers without opening the
// stage-tracking history.
//
// This runs the existing `company-current-scoring` push connection (business_stage → business) from
// the new stage record, reusing the generic sync engine (equality-guarded + convergence-guarded +
// change-logged). It does NOT fan down to contacts: the nightly `company-to-contacts` reconcile
// already carries `*_current` to contacts, keeping contact writes off the real-time webhook path
// (which is implicated in GHL's re-enrollment loop-lock). Company writes don't re-enroll the
// Contact-Changed workflow, so this is loop-safe in real time.

import { loadPushConnection } from '../sync/orchestrate';
import { syncConnection } from '../sync/apply';
import type { GhlClient } from '../ghl/client';

/** DB slug of the business_stage → business "Company Current Scoring" push connection. */
export const CURRENT_SCORING_SLUG = 'company-current-scoring';

export interface PropagateResult {
  ran: boolean;
  /** Why it didn't run (connection missing / no linked company). */
  reason?: string;
  companyId?: string;
  /** Company field keys written (apply) or that would change (dry-run). */
  changed?: string[];
}

/**
 * Propagate a stage record's scores up to its associated company's `*_current` fields. Non-throwing
 * on the "not configured / not linked" cases; genuine engine errors propagate so the caller (which
 * wraps this best-effort) can log them. Safe to call after both create and update of a stage record.
 */
export async function propagateCurrentScoring(
  stageRecordId: string,
  opts: { apply: boolean; client?: GhlClient },
): Promise<PropagateResult> {
  const conn = await loadPushConnection(CURRENT_SCORING_SLUG);
  if (!conn) return { ran: false, reason: `${CURRENT_SCORING_SLUG} connection not configured` };
  if (!conn.rows.some((r) => r.enabled !== false)) return { ran: false, reason: 'no enabled current-scoring mappings' };

  const res = await syncConnection(conn, stageRecordId, { apply: opts.apply }, undefined, opts.client);
  const fwd = res.forward[0]; // business_stage → business is fan-in: at most one company
  if (!fwd) return { ran: false, reason: res.note ?? 'no linked company' };
  const changed = opts.apply ? fwd.written : fwd.changes.map((c) => c.fieldKey);
  return { ran: true, companyId: fwd.targetId, changed };
}
