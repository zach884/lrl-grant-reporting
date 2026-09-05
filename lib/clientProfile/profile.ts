// lib/clientProfile/profile.ts — assemble what the client sees, and diff what they send back.
//
// The company record is the authoritative scoring input (docs/sprints/scoring-enricher-kickoff.md),
// so this reads and writes `business`, not the contact. That also means the rescore adds NO new
// two-way synced field, which is the 2026-08-27 loop incident's lesson applied rather than repeated.
//
// The field LIST is never restated here. It comes from lib/stage/companyInputs.ts via
// inputsForDimensions(), so adding a scoring input changes the client form automatically.

import type { GhlClient } from '../ghl/client';
import type { CustomFieldCatalog, CustomFieldDef } from '../ghl/types';
import { readRecordFields } from '../ghl/records';
import { optionKeyToLabel } from '../ghl/coerce';
import { inputsForDimensions, PATH_DIMENSIONS, valueToText, type ScoringPath } from '../stage/companyInputs';
import { routePath } from '../stage/scoreCompany';

/** Company fields the scorer propagates its latest results onto (lib/stage/propagateScoring.ts). */
export const CURRENT_SCORE_KEYS = {
  trl: 'business.trl_current',
  mrl: 'business.mrl_current',
  crl: 'business.crl_current',
  churchill: 'business.churchill_current',
  churchillSubstage: 'business.churchill_substage_current',
} as const;

export interface ProfileField {
  /** Bare company key, e.g. 'annual_revenue'. What the client POSTs back. */
  key: string;
  label: string;
  dataType: string;
  /** Present for SINGLE_OPTIONS / MULTIPLE_OPTIONS / RADIO / CHECKBOX. Labels, in GHL's order. */
  options?: string[];
  /** Current value as the client should SEE it: option labels, not stored keys. */
  value: string | string[];
  multi: boolean;
  money: boolean;
}

export interface ClientProfile {
  companyId: string;
  companyName: string;
  /** null when business_model is blank or unrecognized — the page asks for it first. */
  path: ScoringPath | null;
  businessModel: { key: string; label: string; options: string[]; value: string };
  scores: { trl?: number; mrl?: number; crl?: number; churchill?: number; churchillSubstage?: string };
  fields: ProfileField[];
}

const defFor = (catalog: CustomFieldCatalog, prefixedKey: string): CustomFieldDef | undefined =>
  catalog.byKey[prefixedKey] ?? catalog.byKey[prefixedKey.replace(/^business\./, '')];

const MULTI_TYPES = new Set(['MULTIPLE_OPTIONS', 'CHECKBOX']);

/** Stored value -> what the client sees. Option KEYS become labels; everything else passes through. */
function displayValue(raw: unknown, def: CustomFieldDef | undefined, multi: boolean): string | string[] {
  if (raw == null || raw === '') return multi ? [] : '';
  const toLabel = (v: unknown) =>
    def?.options?.length ? optionKeyToLabel(String(v), def.options) ?? String(v) : String(v);
  if (multi) {
    const list = Array.isArray(raw) ? raw : String(raw).split(/[,;]/);
    return list.map((v) => toLabel(String(v).trim())).filter(Boolean);
  }
  return toLabel(Array.isArray(raw) ? raw[0] : raw);
}

const numberOrUndefined = (v: unknown): number | undefined => {
  const t = valueToText(v);
  const n = Number(t);
  return t !== '' && Number.isFinite(n) ? n : undefined;
};

/**
 * Read one company and build the routed profile. `catalog` is the business field catalog.
 *
 * Blank inputs are INCLUDED (unlike buildInputBlob, which drops them for the model) — an unanswered
 * question is precisely what we want the client to fill in.
 */
export async function loadClientProfile(
  companyId: string,
  catalog: CustomFieldCatalog,
  client?: GhlClient,
): Promise<ClientProfile> {
  const rf = await readRecordFields('business', companyId, client);
  const get = (k: string) => rf.get(k);

  const modelDef = defFor(catalog, 'business.business_model');
  const modelRaw = get('business.business_model');
  const path = routePath(modelRaw);

  const fields: ProfileField[] = [];
  if (path) {
    for (const input of inputsForDimensions(PATH_DIMENSIONS[path])) {
      const def = defFor(catalog, input.businessKey);
      const dataType = String(def?.dataType ?? 'TEXT');
      const multi = MULTI_TYPES.has(dataType);
      fields.push({
        key: input.businessKey.replace(/^business\./, ''),
        label: input.label,
        dataType,
        options: def?.options?.length ? def.options.map((o: any) => String(o.label ?? o.key ?? o)) : undefined,
        value: displayValue(get(input.businessKey), def, multi),
        multi,
        money: Boolean(input.money),
      });
    }
  }

  return {
    companyId,
    companyName: valueToText(get('business.name') ?? get('name')),
    path,
    fields,
    businessModel: {
      key: 'business_model',
      label: 'Which best describes your business',
      options: modelDef?.options?.length ? modelDef.options.map((o: any) => String(o.label ?? o.key ?? o)) : [],
      value: String(displayValue(modelRaw, modelDef, false)),
    },
    scores: {
      trl: numberOrUndefined(get(CURRENT_SCORE_KEYS.trl)),
      mrl: numberOrUndefined(get(CURRENT_SCORE_KEYS.mrl)),
      crl: numberOrUndefined(get(CURRENT_SCORE_KEYS.crl)),
      churchill: numberOrUndefined(get(CURRENT_SCORE_KEYS.churchill)),
      churchillSubstage: valueToText(get(CURRENT_SCORE_KEYS.churchillSubstage)) || undefined,
    },
  };
}

/** Two display values are "the same answer" — order-insensitive for multi-selects. */
function sameAnswer(a: string | string[], b: string | string[]): boolean {
  const norm = (v: string | string[]) =>
    (Array.isArray(v) ? v : [v]).map((s) => String(s).trim()).filter(Boolean).sort().join(' ');
  return norm(a) === norm(b);
}

export interface SubmissionDiff {
  /** Bare key -> new value. Option fields carry LABELS; setBusinessFields coerces to keys. */
  changed: Record<string, unknown>;
  unchanged: string[];
}

/**
 * Keep only the answers the client actually CHANGED.
 *
 * This matters more than it looks. `writeRecordFields` sends every scalar it is handed and only
 * modifier fields diff internally, so a caller that forwards the whole form rewrites every field on
 * every submit: `noop` becomes unreachable, the change log fills with churn, and `sync:doctor` starts
 * reporting CHURN that is an artifact of the caller. The CALLER diffs. That is the contract.
 *
 * A key the routed profile did not offer is dropped, not written — the token says which company, and
 * the profile says which questions. Neither is taken from the request body.
 */
export function diffSubmission(profile: ClientProfile, submitted: Record<string, unknown>): SubmissionDiff {
  const changed: Record<string, unknown> = {};
  const unchanged: string[] = [];
  const known = new Map(profile.fields.map((f) => [f.key, f]));

  for (const [key, raw] of Object.entries(submitted)) {
    const field = known.get(key);
    if (!field) continue;
    const next = field.multi
      ? (Array.isArray(raw) ? raw : [raw]).map((v) => String(v ?? '').trim()).filter(Boolean)
      : String(raw ?? '').trim();
    if (sameAnswer(next, field.value)) {
      unchanged.push(key);
      continue;
    }
    changed[key] = next;
  }
  return { changed, unchanged };
}
