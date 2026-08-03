// lib/stage/priorAssessment.ts — read a company's PREVIOUS stage assessment (the scorer's "memory").
//
// The architectural change from the legacy workflow (see kickoff doc, "Memory source"): "previous"
// now comes from the latest `custom_objects.business_stage` record associated to the company (via the
// `company_business_stage` association), NOT from contact fields. We fall back to the contact
// `*_current` fields only when no stage record exists yet (i.e. before the history backfill runs) —
// which is also exactly the signal the acceptance test compares the new scorer against.

import { GhlClient, ghl } from '../ghl/client';
import { getAssociatedContactIds, getRelations, listAssociationDefs } from '../ghl/associations';
import { readRecordFields } from '../ghl/records';
import type { PriorAssessment } from './scoreCompany';

export const STAGE_OBJECT = 'custom_objects.business_stage';
export const STAGE_ASSOCIATION_KEY = 'company_business_stage';

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
const str = (v: unknown): string | null => {
  const s = v == null ? '' : String(v).trim();
  return s || null;
};

/** Resolve the company↔stage association id (cached by the caller via `assocId` when scoring in bulk). */
export async function getStageAssociationId(client: GhlClient = ghl()): Promise<string | null> {
  const defs = await listAssociationDefs(client);
  return defs.find((d) => d.key === STAGE_ASSOCIATION_KEY)?.id ?? null;
}

/** Split a stored `stage_rationale` (tech + service joined) back into its two parts, best-effort. */
function splitRationale(combined: string | null): { tech: string | null; service: string | null } {
  if (!combined) return { tech: null, service: null };
  const segments = combined.split(/\n\s*---\s*\n/).map((s) => s.trim()).filter(Boolean);
  let tech: string | null = null;
  let service: string | null = null;
  for (const seg of segments) {
    if (/service path|churchill/i.test(seg)) service = service ? `${service}\n\n${seg}` : seg;
    else tech = tech ? `${tech}\n\n${seg}` : seg;
  }
  // Single unlabeled block: keep it as tech context (harmless — it's only narrative for the re-score).
  if (!tech && !service && segments.length) tech = segments.join('\n\n');
  return { tech, service };
}

/** Map a stage record's fields to a PriorAssessment. */
function fromStageRecord(get: (k: string) => unknown): PriorAssessment {
  const { tech, service } = splitRationale(str(get('stage_rationale')));
  return {
    trl: num(get('trl')),
    mrl: num(get('mrl')),
    crl: num(get('crl')),
    churchillStage: num(get('churchill_score')),
    churchillSubstage: str(get('churchill_substage')),
    techRationale: tech,
    serviceRationale: service,
    source: 'record',
    rescoreDate: str(get('rescore_date')),
  };
}

/** Map a contact's `*_current` fields to a PriorAssessment (pre-backfill fallback). */
function fromContactFields(get: (k: string) => unknown): PriorAssessment | null {
  const trl = num(get('contact.trl_current'));
  const mrl = num(get('contact.mrl_current'));
  const crl = num(get('contact.crl_current'));
  const churchill = num(get('contact.churchill_current'));
  if (trl == null && mrl == null && crl == null && churchill == null) return null;
  return {
    trl, mrl, crl,
    churchillStage: churchill,
    churchillSubstage: str(get('contact.churchill_substage_current')),
    techRationale: str(get('contact.latest_tech_stage_rationale')),
    serviceRationale: str(get('contact.latest_churchill_stage_rationale')),
    source: 'contact-fields',
    rescoreDate: str(get('contact.business_stage_rescored_date')),
  };
}

/** Collect the stage-record ids linked to a company (both relation orientations tolerated). */
async function stageRecordIds(companyId: string, assocId: string, client: GhlClient): Promise<string[]> {
  const rels = await getRelations(companyId, assocId, client);
  const ids: string[] = [];
  for (const r of rels) {
    if (r.secondObjectKey === STAGE_OBJECT && r.secondRecordId) ids.push(r.secondRecordId);
    else if (r.firstObjectKey === STAGE_OBJECT && r.firstRecordId) ids.push(r.firstRecordId);
  }
  return Array.from(new Set(ids));
}

interface LoadedStageRecord { id: string; get: (k: string) => unknown; date: string }

/** Fetch every stage record linked to a company, newest first by rescore_date. */
async function loadStageRecords(companyId: string, assocId: string, client: GhlClient): Promise<LoadedStageRecord[]> {
  let ids: string[] = [];
  try { ids = await stageRecordIds(companyId, assocId, client); } catch { return []; }
  const records: LoadedStageRecord[] = [];
  for (const id of ids) {
    try {
      const rf = await readRecordFields(STAGE_OBJECT, id, client);
      records.push({ id, get: rf.get, date: String(rf.get('rescore_date') ?? '') });
    } catch { /* skip unreadable record */ }
  }
  records.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // newest first
  return records;
}

/** An associated contact's *_current fields (pre-backfill fallback), or null. */
async function contactFallback(companyId: string, client: GhlClient): Promise<PriorAssessment | null> {
  let contactIds: string[] = [];
  try { contactIds = await getAssociatedContactIds(companyId, client); } catch { return null; }
  for (const cid of contactIds) {
    try {
      const rf = await readRecordFields('contact', cid, client);
      const prior = fromContactFields(rf.get);
      if (prior) return prior;
    } catch { /* skip */ }
  }
  return null;
}

const dayOf = (v: string) => String(v).slice(0, 10);

export interface PriorAssessmentOptions {
  client?: GhlClient;
  /** Preresolved association id (avoids a lookup per company in bulk runs). */
  assocId?: string | null;
}

/** Everything the scorer's apply step needs about a company's stage history, in one fetch. */
export interface CompanyStageContext {
  /** Latest assessment BEFORE `today` (a prior-day stage record, else the contact-field fallback). */
  prior: PriorAssessment | null;
  /** Id of the stage record already dated `today`, if any → the scorer OVERWRITES it (idempotent
   *  same-day re-scoring / correction) instead of appending a duplicate. */
  todayRecordId: string | null;
}

/**
 * Read a company's stage history for a scoring run dated `today` (YYYY-MM-DD). Excludes today's own
 * record when choosing the "prior" so a same-day re-run compares against the last REAL prior, not the
 * record it's about to overwrite. Falls back to contact `*_current` fields when no prior-day record exists.
 */
export async function getCompanyStageContext(
  companyId: string,
  today: string,
  opts: PriorAssessmentOptions = {},
): Promise<CompanyStageContext> {
  const client = opts.client ?? ghl();
  const assocId = opts.assocId ?? (await getStageAssociationId(client));
  const records = assocId ? await loadStageRecords(companyId, assocId, client) : [];
  const todayRec = records.find((r) => dayOf(r.date) === today) ?? null;
  const priorRec = records.find((r) => dayOf(r.date) !== today) ?? null; // newest-first → first non-today
  const prior = priorRec ? fromStageRecord(priorRec.get) : await contactFallback(companyId, client);
  return { prior, todayRecordId: todayRec?.id ?? null };
}

/**
 * The company's most recent prior assessment, or null if never scored. Prefers the latest linked stage
 * record (by rescore_date); falls back to an associated contact's `*_current` fields. (Thin wrapper over
 * getCompanyStageContext with no same-day exclusion — kept for callers that only want "the latest".)
 */
export async function getPriorAssessment(
  companyId: string,
  opts: PriorAssessmentOptions = {},
): Promise<PriorAssessment | null> {
  const client = opts.client ?? ghl();
  const assocId = opts.assocId ?? (await getStageAssociationId(client));
  const records = assocId ? await loadStageRecords(companyId, assocId, client) : [];
  if (records.length) return fromStageRecord(records[0].get);
  return contactFallback(companyId, client);
}
