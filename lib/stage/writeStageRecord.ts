// lib/stage/writeStageRecord.ts — CREATE a new Client Stage Tracking record per scoring event and
// associate it to the company. Unlike the fill-empty enrichment engines (recordEngine/contactEngine),
// the scorer appends a NEW record each run (per-company scoring HISTORY), mirroring the write path in
// scripts-ts/backfill-client-stage.ts. Object: custom_objects.business_stage; assoc: company_business_stage.

import { GhlClient, ghl } from '../ghl/client';
import { createRelation } from '../ghl/associations';
import { toGhlDate, resolveOptionLabel } from '../ghl/coerce';
import { writeRecordFields } from '../ghl/writeRecord';
import type { CustomFieldCatalog } from '../ghl/types';
import type { StageScore } from './scoreCompany';
import { STAGE_OBJECT } from './priorAssessment';

export interface BuildStagePropsInput {
  score: StageScore;
  /** Human name for the record label (company name, else id). */
  name: string;
  /** Assessment timestamp (default now). */
  rescoreDate?: string | Date;
}

/** The stage_rationale field = tech note + service note joined (same separator the backfill uses). */
export function joinRationale(score: StageScore): string {
  return [score.techRationale, score.serviceRationale].filter(Boolean).join('\n\n---\n\n');
}

/**
 * Build the `properties` payload for a new stage record (pure — unit-tested). snapshot_kind is
 * "Rescore" when the score came from the re-score variant, else "Initial"; rescore_method is "AI".
 * Both single-selects are resolved to the exact stored option label via the catalog.
 */
export function buildStageProperties(input: BuildStagePropsInput, catalog: CustomFieldCatalog): Record<string, unknown> {
  const { score } = input;
  const methodOpts = catalog.byKey[`${STAGE_OBJECT}.rescore_method`]?.options;
  const kindOpts = catalog.byKey[`${STAGE_OBJECT}.snapshot_kind`]?.options;
  const substageOpts = catalog.byKey[`${STAGE_OBJECT}.churchill_substage`]?.options;
  const date = input.rescoreDate ?? new Date().toISOString();
  const dateStr = (date instanceof Date ? date.toISOString() : String(date)).slice(0, 10);
  const kind = score.rescore ? 'Rescore' : 'Initial';

  const props: Record<string, unknown> = {
    name: `${input.name} — ${kind} ${dateStr}`,
    rescore_date: toGhlDate(date),
    rescore_method: resolveOptionLabel('AI', methodOpts) ?? 'AI',
    snapshot_kind: resolveOptionLabel(kind, kindOpts) ?? kind,
  };
  if (score.trl != null) props.trl = score.trl;
  if (score.mrl != null) props.mrl = score.mrl;
  if (score.crl != null) props.crl = score.crl;
  if (score.churchillStage != null) props.churchill_score = score.churchillStage;
  // churchill_substage is now SINGLE_OPTIONS [III-D, III-G, N/A] — resolve to the exact option label.
  if (score.churchillSubstage) props.churchill_substage = resolveOptionLabel(score.churchillSubstage, substageOpts) ?? score.churchillSubstage;
  const rationale = joinRationale(score);
  if (rationale) props.stage_rationale = rationale;
  // source_contact_id field was removed (Zach, 2026-07-31); total_business_stage_advancement is DEFERRED.
  return props;
}

export interface CreateStageRecordDeps {
  catalog: CustomFieldCatalog;
  /** company_business_stage association id (resolve once, reuse in bulk). */
  assocId: string;
  companyId: string;
  client?: GhlClient;
}

/**
 * Create the stage record and link it to the company. Returns the new record id and the properties
 * written (for logging). Association orientation matches the backfill: company = firstRecordId.
 */
export async function createStageRecord(
  input: BuildStagePropsInput,
  deps: CreateStageRecordDeps,
): Promise<{ recordId: string; properties: Record<string, unknown> }> {
  const client = deps.client ?? ghl();
  const properties = buildStageProperties(input, deps.catalog);
  const res = await client.request<any>({
    method: 'POST',
    path: `/objects/${STAGE_OBJECT}/records`,
    autoLocation: false,
    body: { locationId: client.locationId, properties },
  });
  const recordId = res.record?.id ?? res.id;
  if (!recordId) throw new Error('stage record create returned no id');
  await createRelation(
    { associationId: deps.assocId, firstRecordId: deps.companyId, secondRecordId: recordId },
    client,
  );
  return { recordId, properties };
}

/**
 * Overwrite an existing stage record in place (same-day re-score / correction) — updates every scored
 * field, rationale, method, and name; the company association is already in place so it is untouched.
 * Use for the record getCompanyStageContext returns as `todayRecordId`.
 */
export async function updateStageRecord(
  recordId: string,
  input: BuildStagePropsInput,
  deps: { catalog: CustomFieldCatalog; client?: GhlClient },
): Promise<{ recordId: string; properties: Record<string, unknown> }> {
  const client = deps.client ?? ghl();
  const properties = buildStageProperties(input, deps.catalog);
  await writeRecordFields(STAGE_OBJECT, recordId, properties, deps.catalog, client);
  return { recordId, properties };
}
