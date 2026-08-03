// lib/stage/companyInputs.ts — the 18 COMPANY-side scoring inputs for the Client Stage scorer.
//
// The legacy GHL workflow read {{contact.*}} intake answers; the new enricher is company-scoped
// (see docs/sprints/scoring-enricher-kickoff.md): contacts fill forms → the up-sync carries the
// answers up to the Company → the Company record is the authoritative scoring input. Each input
// below is the `business.*` counterpart of a contact key (derived from config/field-mappings.json)
// and is tagged with the readiness dimension(s) it feeds, so the consolidated scorer only shows a
// path the inputs that path actually needs.

import { optionKeyToLabel } from '../ghl/coerce';
import type { CustomFieldCatalog } from '../ghl/types';

/** Which readiness dimension a scoring input informs. */
export type Dimension = 'trl' | 'mrl' | 'crl' | 'churchill';

/** Scoring path, routed from `business.business_model` (see scoreCompany.routePath). */
export type ScoringPath = 'tech' | 'service' | 'both';

/** The dimensions each path produces. tech = TRL/MRL/CRL; service = Churchill; both = all four. */
export const PATH_DIMENSIONS: Record<ScoringPath, Dimension[]> = {
  tech: ['trl', 'mrl', 'crl'],
  service: ['churchill'],
  both: ['trl', 'mrl', 'crl', 'churchill'],
};

export interface ScoringInput {
  /** Company field key (prefixed), e.g. 'business.description'. */
  businessKey: string;
  /** Human label — kept verbatim from the GHL prompts so calibration is unchanged. */
  label: string;
  /** Dimensions this input feeds. */
  dims: Dimension[];
  /** Prefix the value with "$" (revenue). */
  money?: boolean;
}

/**
 * The 19 scoring inputs. `businessKey` values were derived from config/field-mappings.json (the
 * live contact→company pairs) and confirmed against the live `business` object catalog. Labels and
 * dimension assignments mirror the per-dimension prompts in the kickoff doc.
 */
export const SCORING_INPUTS: ScoringInput[] = [
  // Context — feeds every dimension.
  { businessKey: 'business.description', label: 'Company description', dims: ['trl', 'mrl', 'crl', 'churchill'] },
  { businessKey: 'business.where_are_you_today', label: 'Where they are today', dims: ['trl', 'mrl', 'crl', 'churchill'] },
  // TRL signals.
  { businessKey: 'business.tech_product_state', label: 'Current state of technology / product', dims: ['trl'] },
  { businessKey: 'business.patents', label: 'Patents', dims: ['trl'] },
  { businessKey: 'business.independent_validation_company', label: 'Independent validation', dims: ['trl'] },
  // MRL signals.
  { businessKey: 'business.mfg_method', label: 'How is your product manufactured today', dims: ['mrl'] },
  { businessKey: 'business.mfg_partner_status', label: 'Manufacturing partner status', dims: ['mrl'] },
  // CRL signals.
  { businessKey: 'business.paying_customers', label: 'Number of paying customers today', dims: ['crl'] },
  { businessKey: 'business.selling_stage', label: 'Where they are with selling', dims: ['crl'] },
  { businessKey: 'business.product_market_fit', label: 'Self-reported product-market fit', dims: ['crl'] },
  // Shared revenue signal (CRL + Churchill). `annual_revenue` is the sole revenue input — the legacy
  // `revenue_stage` was a redundant restatement of the same thing and isn't collected on the intake
  // form, so it was dropped (Zach, 2026-07-31).
  { businessKey: 'business.annual_revenue', label: 'Annual revenue (last 12 months)', dims: ['crl', 'churchill'], money: true },
  // Churchill signals.
  { businessKey: 'business.date_of_incorporation', label: 'Date business founded', dims: ['churchill'] },
  { businessKey: 'business.fte_current', label: 'Current FTE', dims: ['churchill'] },
  { businessKey: 'business.fte_hiring_next_12mo', label: 'Planned FTE next 12 months', dims: ['churchill'] },
  { businessKey: 'business.owner_involvement', label: 'Owner involvement', dims: ['churchill'] },
  { businessKey: 'business.cash_flow_today', label: 'Cash flow today', dims: ['churchill'] },
  { businessKey: 'business.locations_sites', label: 'Locations / sites', dims: ['churchill'] },
  { businessKey: 'business.management_team', label: 'Management layer', dims: ['churchill'] },
];

/** Every business key a scoring input reads (for coverage checks in the runner). */
export const SCORING_INPUT_KEYS: string[] = SCORING_INPUTS.map((i) => i.businessKey);

/** The subset of inputs that inform any of the given dimensions, in declaration order. */
export function inputsForDimensions(dims: Dimension[]): ScoringInput[] {
  const set = new Set(dims);
  return SCORING_INPUTS.filter((i) => i.dims.some((d) => set.has(d)));
}

/**
 * Wrap a field accessor so SINGLE/MULTIPLE_OPTIONS values render as human LABELS — the form the
 * legacy GHL workflow scored on — instead of the stored snake_case option keys (e.g. GHL persists
 * "working_prototype_tested_..." not "Working prototype tested ..."). Non-option fields pass through
 * unchanged. Pass the `business` field catalog. Preserves calibration parity with the old prompts.
 */
export function labelResolvingAccessor(
  field: (key: string) => unknown,
  catalog: CustomFieldCatalog,
): (key: string) => unknown {
  return (key: string) => {
    const raw = field(key);
    if (raw == null || raw === '') return raw;
    const def = catalog.byKey[key] ?? catalog.byKey[`business.${key}`];
    if (!def?.options?.length) return raw;
    if (Array.isArray(raw)) return raw.map((v) => optionKeyToLabel(v, def.options) ?? v);
    return optionKeyToLabel(raw, def.options) ?? raw;
  };
}

/** Coerce a stored field value to a trimmed display string (arrays joined; null/empty → ''). */
export function valueToText(raw: unknown): string {
  if (raw == null) return '';
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean).join(', ');
  return String(raw).trim();
}

/**
 * Assemble the labeled input blob the scorer sees, using a field accessor (bare or prefixed keys —
 * e.g. the `get` from lib/ghl/records.readRecordFields). Only inputs feeding `dims` are included,
 * and blank inputs are dropped so the model isn't fed empty lines. Company name is prepended when
 * available. `field('name')` / `field('business.name')` supplies the company name.
 */
export function buildInputBlob(field: (key: string) => unknown, dims: Dimension[]): string {
  const lines: string[] = [];
  const name = valueToText(field('business.name') ?? field('name'));
  if (name) lines.push(`Company: ${name}`);
  for (const input of inputsForDimensions(dims)) {
    const text = valueToText(field(input.businessKey));
    if (!text) continue;
    lines.push(`${input.label}: ${input.money ? '$' + text : text}`);
  }
  return lines.join('\n');
}
