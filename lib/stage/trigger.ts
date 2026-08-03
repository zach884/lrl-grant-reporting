// lib/stage/trigger.ts — real-time dispatch for the Client Stage scorer.
//
// The scorer is company-scoped but the triggering event is a CONTACT change: a contact edits an
// intake field → the up-sync pushes it to the company → THIS runs and (re)scores the company,
// upserting today's stage record. Wired into /api/sync/up.ts alongside the field enrichers.
//
// Unlike the field enrichers it is NOT an Enricher (it creates/updates a record, not company fields),
// so it can't live in defaultEnrichers. It still participates in the enricher UI + config system via
// STAGE_SCORER_META + a DEFAULT_ENRICHER_CONFIGS entry, so it shows on /enrichment and is toggleable.
//
// Cost guard: a scoring run is one Sonnet call, so we only fire when a field that actually feeds the
// score changed on the company (SCORE_TRIGGER_KEYS) — not on every unrelated contact edit.

import type { GhlClient } from '../ghl/client';
import { ghl } from '../ghl/client';
import type { CustomFieldCatalog } from '../ghl/types';
import { getCatalog } from '../ghl/catalogCache';
import { readRecordFields } from '../ghl/records';
import { resolveEnricherConfig } from '../enrichment/configStore';
import { evaluateGate } from '../enrichment/gate';
import { routePath, scoreCompany } from './scoreCompany';
import { buildInputBlob, labelResolvingAccessor, PATH_DIMENSIONS, SCORING_INPUT_KEYS } from './companyInputs';
import { getCompanyStageContext, getStageAssociationId, STAGE_OBJECT } from './priorAssessment';
import { createStageRecord, updateStageRecord } from './writeStageRecord';
import { fingerprint, getEnricherState, setEnricherState } from '../enrichment/stateStore';

/** Registry meta for the enricher UI (the scorer isn't an Enricher object, so this is its stand-in). */
export const STAGE_SCORER_NAME = 'client-stage-scorer';
export const STAGE_SCORER_META = {
  name: STAGE_SCORER_NAME,
  description:
    'Score a company on TRL/MRL/CRL and/or Churchill (routed by business model) with one Claude call, ' +
    'appending a Client Stage Tracking record per scoring event. Runs when a scoring input changes.',
  produces: ['trl', 'mrl', 'crl', 'churchill_score', 'churchill_substage', 'stage_rationale'],
  target: 'company' as const,
  sourceObject: 'business',
  gateWired: true,
};

/** Bare company keys that feed the score — a change to any of these (re)triggers scoring. */
export const SCORE_TRIGGER_KEYS: Set<string> = new Set(
  ['business.business_model', ...SCORING_INPUT_KEYS].map((k) => (k.includes('.') ? k.split('.').slice(1).join('.') : k)),
);

/** True when any changed (bare) company field feeds the score. */
export function scoringInputChanged(changedBareKeys: string[]): boolean {
  return changedBareKeys.some((k) => SCORE_TRIGGER_KEYS.has(k));
}

export interface StageTriggerResult {
  ran: boolean;
  /** Why it didn't run / what happened. */
  reason?: string;
  path?: string;
  action?: 'created' | 'updated' | 'would-create' | 'would-update';
  recordId?: string;
  scores?: { trl?: number; mrl?: number; crl?: number; churchillStage?: number; churchillSubstage?: string };
}

export interface StageTriggerOptions {
  apply: boolean;
  client?: GhlClient;
  /** Reuse the business catalog if the caller already loaded it. */
  businessCatalog?: CustomFieldCatalog;
  today?: string; // YYYY-MM-DD (default now)
  /** Bypass the input-fingerprint gate and (re)score regardless (manual/preview/backfill). */
  force?: boolean;
}

/**
 * Score one company and upsert its stage record for today. Safe to call on EVERY webhook: it gates on
 * the record's STATE, not the app's up-sync diff. It (re)scores when the company has never been scored
 * (create) or when a scoring input changed since the last score (input fingerprint differs), and skips
 * — with no Claude call — when the inputs are unchanged. Honors the enricher's enabled/gate config.
 * Never throws to the caller's critical path — returns a structured result the webhook can log.
 */
export async function runStageScoreTrigger(companyId: string, opts: StageTriggerOptions): Promise<StageTriggerResult> {
  const client = opts.client ?? ghl();

  // Config: enabled + optional gate (evaluated against the company's fields).
  const config = await resolveEnricherConfig(STAGE_SCORER_NAME, 'business');
  if (config.enabled === false) return { ran: false, reason: 'disabled' };

  const businessCatalog = opts.businessCatalog ?? (await getCatalog('business', { client }));
  const rf = await readRecordFields('business', companyId, client);
  const field = labelResolvingAccessor(rf.get, businessCatalog);

  const gate = evaluateGate((k) => field(k), config);
  if (!gate.run) return { ran: false, reason: gate.reason ?? 'gated out' };

  const path = routePath(field('business.business_model'));
  if (!path) return { ran: false, reason: 'no business model — cannot route' };

  // Nothing to score from → skip (don't create an empty record).
  const blob = buildInputBlob(field, PATH_DIMENSIONS[path]);
  if (!blob.trim()) return { ran: false, reason: 'no scoring inputs populated' };

  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const assocId = await getStageAssociationId(client);
  const ctx = await getCompanyStageContext(companyId, today, { client, assocId });

  // Fingerprint gate: (re)score on create (never scored) or when the inputs changed; skip an
  // unchanged re-fire with NO Claude call. State-based, so it's correct even when GHL native sync
  // populated the company (an empty app diff would otherwise have hidden the change).
  const inputHash = fingerprint(blob);
  const hasRecord = Boolean(ctx.todayRecordId) || ctx.prior?.source === 'record';
  if (!opts.force && hasRecord) {
    const state = await getEnricherState(companyId);
    if (state?.scoreInputHash === inputHash) return { ran: false, reason: 'inputs unchanged since last score' };
  }

  const score = await scoreCompany({ field, path, prior: ctx.prior });
  if (!score) return { ran: false, reason: 'scorer returned no result' };

  const scores = { trl: score.trl, mrl: score.mrl, crl: score.crl, churchillStage: score.churchillStage, churchillSubstage: score.churchillSubstage };
  const nameRf = rf.get('business.name') ?? rf.get('name');
  const name = (nameRf ? String(nameRf) : '') || companyId;
  const willOverwrite = Boolean(ctx.todayRecordId);

  if (!opts.apply) {
    return { ran: true, path, action: willOverwrite ? 'would-update' : 'would-create', recordId: ctx.todayRecordId ?? undefined, scores };
  }
  if (!assocId && !ctx.todayRecordId) return { ran: false, reason: 'company_business_stage association not found' };

  const propsInput = { score, name, rescoreDate: today };
  if (ctx.todayRecordId) {
    await updateStageRecord(ctx.todayRecordId, propsInput, { catalog: await getCatalog(STAGE_OBJECT, { client }), client });
    await setEnricherState(companyId, { scoreInputHash: inputHash });
    return { ran: true, path, action: 'updated', recordId: ctx.todayRecordId, scores };
  }
  const res = await createStageRecord(propsInput, { catalog: await getCatalog(STAGE_OBJECT, { client }), assocId: assocId!, companyId, client });
  await setEnricherState(companyId, { scoreInputHash: inputHash });
  return { ran: true, path, action: 'created', recordId: res.recordId, scores };
}
