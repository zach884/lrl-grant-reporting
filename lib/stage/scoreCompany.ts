// lib/stage/scoreCompany.ts — the Client Stage scorer (company-scoped, one consolidated Claude call).
//
// Replaces the legacy 7-prompt GHL "chatgpt" workflow with a SINGLE structured call that returns all
// outputs for the client's path at once (see docs/sprints/scoring-enricher-kickoff.md, "EFFICIENCY").
// The rubric text and per-dimension "primary signal" guidance are kept VERBATIM from that workflow so
// calibration is preserved; only the plumbing (7 calls → 1 JSON call) changed.
//
// Routing (Zach, 2026-07-28): the client's `business.business_model` decides which dimensions run —
//   Product  → tech-path    (TRL, MRL, CRL + tech rationale)
//   Service  → service-path (Churchill stage + sub-stage + service rationale)
//   Both     → all four + both rationales
// A blank/unrecognized business_model returns null from routePath — the runner SKIPS that company.
//
// Two variants share one prompt: INITIAL (no prior record) and RE-SCORE (a prior assessment is fed
// back in → the rationale fields describe what changed vs. stayed).

import { classifyJson, hasAnthropic, SCORING_MODEL } from '../ai/anthropic';
import {
  buildInputBlob,
  PATH_DIMENSIONS,
  valueToText,
  type Dimension,
  type ScoringPath,
} from './companyInputs';

export type ChurchillSubstage = 'III-D' | 'III-G' | 'N/A';

/** A prior assessment fed into the re-score variant (from a stage record, or contact *_current fields). */
export interface PriorAssessment {
  trl: number | null;
  mrl: number | null;
  crl: number | null;
  churchillStage: number | null;
  churchillSubstage: string | null;
  techRationale: string | null;
  serviceRationale: string | null;
  /** Where the prior values came from — for run logging. */
  source: 'record' | 'contact-fields';
  /** ISO date of the prior assessment, when known. */
  rescoreDate?: string | null;
}

/** The scorer's output. Only the requested path's fields are populated. */
export interface StageScore {
  path: ScoringPath;
  trl?: number;
  mrl?: number;
  crl?: number;
  churchillStage?: number;
  churchillSubstage?: ChurchillSubstage;
  techRationale?: string;
  serviceRationale?: string;
  /** True when this run had a prior assessment (re-score variant). */
  rescore: boolean;
  /** Model id used. */
  model: string;
}

// ── Routing ──────────────────────────────────────────────────────────────────

/**
 * Map a `business.business_model` value to a scoring path. The live options are long descriptive
 * sentences (see the field catalog), so we match on stable keywords. "Both" is checked first because
 * that option also contains the word "developing a new product". Returns null for blank/unrecognized
 * — the caller skips the company (Zach, 2026-07-28).
 */
export function routePath(businessModel: unknown): ScoringPath | null {
  // The live field stores the option KEY (snake_case slug of the long label), but reads elsewhere may
  // surface the label prose — normalize underscores/hyphens/whitespace to one space so either matches.
  const v = valueToText(businessModel).toLowerCase().replace(/[_\s-]+/g, ' ').trim();
  if (!v) return null;
  if (v.startsWith('both') || v === 'both') return 'both';
  if (v.includes('developing a new product') || v === 'product' || v === 'tech') return 'tech';
  if (v.includes('delivering or operating a service') || v === 'service') return 'service';
  return null;
}

// ── Verbatim rubrics (do not reword — calibration depends on this text) ────────

const TRL_SCALE = `TRL (Technology Readiness Level, 1-9):
  1. Basic principles observed - research begun; no implementation yet (literature review, hypothesis only).
  2. Concept formulated - practical applications articulated; speculative, no proof or detailed analysis (white paper, concept sketch).
  3. Proof of concept - active R&D; analytical or experimental work shows critical function in a controlled setting (bench-top experiment).
  4. Lab-validated component - components integrated and validated in a laboratory environment (working subsystem, lab demo).
  5. Validated in relevant environment - components validated in a relevant (not yet operational) environment (breadboard tested in field-like conditions).
  6. Prototype in relevant environment - system or subsystem prototype demonstrated outside the lab (working prototype tested in field-like conditions).
  7. Prototype in operational environment - system prototype demonstrated in real conditions (pilot deployment, beta with real users).
  8. System qualified - actual system completed and qualified through test and demonstration (production-intent unit, certifications).
  9. System proven - actual system proven through successful operations (sustained commercial deployment).`;

const MRL_SCALE = `MRL (Manufacturing Readiness Level, 1-10):
  1. Manufacturing implications identified.
  2. Manufacturing concepts identified.
  3. Manufacturing proof of concept.
  4. Lab-environment production capability.
  5. Production-relevant environment (component).
  6. Production-relevant environment (system).
  7. Production-representative environment.
  8. Pilot line capability.
  9. Low-rate production.
  10. Full-rate production.`;

const CRL_SCALE = `CRL (Commercial Readiness Level, 1-9):
  1. Opportunity hypothesis - market opportunity hypothesized; no customer contact yet.
  2. Value proposition formulated - segment and value prop articulated; customer discovery.
  3. Problem-solution fit - evidenced through interviews, LOIs, or design partnerships.
  4. Early customer trials - first paid pilots or trials; PMF hypothesized but not validated.
  5. Product-market fit - PMF validated with early adopters; repeated paid usage.
  6. Initial market traction - repeatable sales motion; multiple paying customers; initial revenue.
  7. Scaling go-to-market - proven channels; growing revenue; first hires beyond founders.
  8. Established market presence - recognized in the market; sustainable revenue.
  9. Market leadership - mature commercial operation; market leader.`;

const CHURCHILL_SCALE = `Churchill & Lewis stage (1-5). A company's stage is defined by its DEMONSTRATED operating reality — whether a product/service is actually being delivered to paying customers, at what scale, and with how much organization behind it — NOT by self-reported adjectives or future plans.
  1. Existence - still proving the business works: winning first customers and delivering the product/service. Owner does almost everything; few or no employees; little or no meaningful revenue. Includes anything pre-product or pre-customer ("just an idea", "no product or customers yet").
  2. Survival - a workable business with enough repeat customers and operations to deliver reliably; the central concern is revenue vs. expenses (break-even to modestly cash-generating). Still small and owner-centric.
  3. Success - genuinely healthy and profitable at meaningful scale, with enough employees/managers that the owner is no longer doing everything and could step back. The owner faces a real "stay-put vs. grow" choice. A solo operator or owner-does-everything shop is NOT Stage 3 even if it reports being "profitable".
  4. Take-off - an already-established, revenue-generating Stage-3 business that is NOW growing rapidly (growth already happening, not merely planned), straining delegation and the cash to finance that growth.
  5. Resource Maturity - large, professionally managed, established systems and substantial resources; rapid growth has been consolidated.
Sub-stage (ONLY when stage = 3; otherwise N/A):
  III-D (Disengagement) - owner holding at this size, extracting profits; modest plans. Planned FTE growth <25%; management owner-only or owner + a few supervisors.
  III-G (Growth) - owner reinvesting and preparing for take-off. Planned FTE growth >25% OR a management team is being established.`;

// Per-dimension "primary signal" guidance — verbatim from the classifier prompts.
const TRL_GUIDANCE =
  `TRL: Use "Current state of technology / product" as the primary signal — it maps directly to TRL levels 1-8. ` +
  `Patents and independent validation are corroborating evidence: granted patents and regulatory clearance suggest higher TRL. ` +
  `"Where they are today" and the company description provide context for borderline cases. If the client's offering is primarily ` +
  `software with no novel technology (e.g., a standard CRUD web app), TRL is generally less meaningful; score conservatively.`;
const MRL_GUIDANCE =
  `MRL: Use "How is your product manufactured today" as the primary signal — it maps almost directly to MRL 1-7. Manufacturing ` +
  `partner status corroborates ("actively producing with us" suggests MRL 6+). If the client selected "Not yet manufactured" ` +
  `(typically software-only or pre-prototype), score MRL = 1.`;
const CRL_GUIDANCE =
  `CRL: "Where they are with selling" is the primary signal — it maps directly to CRL 1-8. Paying customers and revenue corroborate. ` +
  `PMF = Yes pushes toward 5+; Working on it suggests 3-4; No suggests ≤3. If inputs conflict (e.g., "Scaling" but 0 paying ` +
  `customers), trust the more conservative signal.`;
const CHURCHILL_GUIDANCE =
  `Churchill: Determine the stage from what the company ACTUALLY has in operation today. Work down this list and STOP at the ` +
  `first stage that fits:\n` +
  `  • No product yet, OR no paying customers yet, OR the owner is still proving the business works → Stage 1 — regardless of ` +
  `headcount plans, management-team claims, or a "profitable" self-report.\n` +
  `  • A real product/service delivered to repeat paying customers, covering costs but small and owner-dependent → Stage 2.\n` +
  `  • Consistently profitable AND large/organized enough (real employees or managers; owner not doing everything) that the owner ` +
  `could disengage → Stage 3.\n` +
  `  • A Stage-3-caliber business already in rapid, active growth → Stage 4.\n` +
  `  • Mature, professionally managed, well-resourced → Stage 5.\n` +
  `Weight the signals that describe the REAL current state most: "Where they are today", the company description, actual revenue, ` +
  `current FTE, owner involvement, and management layer. Treat "Cash flow today" adjectives (e.g. "profitable") and PLANNED/future ` +
  `FTE as corroborating only — never let a "profitable" label or an aspirational hiring plan alone push a tiny, owner-run, or ` +
  `pre-customer business into Stage 3+. When signals conflict, choose the LOWER (more conservative) stage: a business cannot be ` +
  `past Stage 2 without a real product AND paying customers actually in operation.`;

/** Bounds per numeric dimension (for the schema + clamp). */
const DIM_RANGE: Record<Exclude<Dimension, never>, { min: number; max: number }> = {
  trl: { min: 1, max: 9 },
  mrl: { min: 1, max: 10 },
  crl: { min: 1, max: 9 },
  churchill: { min: 1, max: 5 },
};

// ── Prompt + schema assembly (pure — unit-tested without an API call) ──────────

export const SCORE_SYSTEM_PROMPT =
  `You are a business-stage scoring analyst for Lean Rocket Lab, a Michigan-based startup incubator. ` +
  `You assess a client company on standard readiness ladders using its intake data. Score strictly from ` +
  `the evidence provided; when signals conflict, prefer the more conservative reading. You produce integer ` +
  `scores plus a short written rationale documenting what drove each score, so LRL staff can understand the ` +
  `reasoning later. Return ONLY the structured JSON object requested — no extra text.`;

/** JSON-schema for the requested path's outputs (dimensions drive which fields are required). */
export function buildScoreSchema(dims: Dimension[]): Record<string, unknown> {
  const set = new Set(dims);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  // Structured outputs reject minimum/maximum on integer types, so the bound lives in the description
  // and is enforced by the clamp in parseScoreResult.
  const intField = (_d: Dimension, desc: string) => ({ type: 'integer', description: desc });
  if (set.has('trl')) { properties.trl = intField('trl', 'TRL score, integer 1-9.'); required.push('trl'); }
  if (set.has('mrl')) { properties.mrl = intField('mrl', 'MRL score, integer 1-10.'); required.push('mrl'); }
  if (set.has('crl')) { properties.crl = intField('crl', 'CRL score, integer 1-9.'); required.push('crl'); }
  if (set.has('trl') || set.has('mrl') || set.has('crl')) {
    properties.tech_rationale = {
      type: 'string',
      description:
        'Tech-path note. Format exactly:\n"Stage Scoring — Tech Path" (add " (Re-Score)" when a previous ' +
        'assessment is given), then for each of TRL/MRL/CRL that was scored a line "TRL = <n>" (re-score: ' +
        '"TRL: <prev> → <n>") followed by 1-3 sentences citing the rubric level NAME and the specific input ' +
        'evidence (re-score: what advanced/regressed, or a brief "no change" note).',
    };
    required.push('tech_rationale');
  }
  if (set.has('churchill')) {
    properties.churchill_score = intField('churchill', 'Churchill & Lewis stage, integer 1-5.');
    properties.churchill_substage = {
      type: 'string',
      enum: ['III-D', 'III-G', 'N/A'],
      description: 'Sub-stage — ONLY meaningful when stage = 3 (otherwise "N/A").',
    };
    properties.service_rationale = {
      type: 'string',
      description:
        'Service-path note. Format exactly:\n"Stage Scoring — Service Path" (add " (Re-Score)" when a previous ' +
        'assessment is given), then "Churchill Stage = <n>" (re-score: "Churchill Stage: <prev> → <n>") + 2-3 ' +
        'sentences citing the rubric stage NAME and specific input evidence, then "Sub-Stage = <val>" ' +
        '(re-score: "Sub-Stage: <prev> → <val>") + 1 sentence (state "not applicable" when N/A).',
    };
    required.push('churchill_score', 'churchill_substage', 'service_rationale');
  }
  return { type: 'object', additionalProperties: false, properties, required };
}

/** Render the "Previous assessment" block for the re-score variant (empty string for initial). */
function priorBlock(dims: Dimension[], prior: PriorAssessment | null | undefined): string {
  if (!prior) return '';
  const set = new Set(dims);
  const lines: string[] = ['Previous assessment (before this re-score):'];
  if (set.has('trl')) lines.push(`  TRL = ${prior.trl ?? 'n/a'}`);
  if (set.has('mrl')) lines.push(`  MRL = ${prior.mrl ?? 'n/a'}`);
  if (set.has('crl')) lines.push(`  CRL = ${prior.crl ?? 'n/a'}`);
  if ((set.has('trl') || set.has('mrl') || set.has('crl')) && prior.techRationale) {
    lines.push('  Previous tech rationale:', prior.techRationale);
  }
  if (set.has('churchill')) {
    lines.push(`  Churchill Stage = ${prior.churchillStage ?? 'n/a'}`);
    lines.push(`  Sub-Stage = ${prior.churchillSubstage ?? 'N/A'}`);
    if (prior.serviceRationale) lines.push('  Previous service rationale:', prior.serviceRationale);
  }
  lines.push('For each score, state what changed (or didn\'t) vs. the previous assessment and why.');
  return lines.join('\n');
}

/** Build the user prompt for a scoring call. Pure function of (path, input blob, prior). */
export function buildScorePrompt(opts: {
  path: ScoringPath;
  inputBlob: string;
  prior?: PriorAssessment | null;
}): { system: string; user: string } {
  const dims = PATH_DIMENSIONS[opts.path];
  const set = new Set(dims);
  const parts: string[] = [];

  const wanted = [
    set.has('trl') ? 'TRL' : null,
    set.has('mrl') ? 'MRL' : null,
    set.has('crl') ? 'CRL' : null,
    set.has('churchill') ? 'Churchill stage (and sub-stage)' : null,
  ].filter(Boolean);
  parts.push(`Score this client on: ${wanted.join(', ')}.`);

  const scales: string[] = [];
  if (set.has('trl')) scales.push(TRL_SCALE);
  if (set.has('mrl')) scales.push(MRL_SCALE);
  if (set.has('crl')) scales.push(CRL_SCALE);
  if (set.has('churchill')) scales.push(CHURCHILL_SCALE);
  parts.push('Scales:\n' + scales.join('\n\n'));

  const guidance: string[] = [];
  if (set.has('trl')) guidance.push(TRL_GUIDANCE);
  if (set.has('mrl')) guidance.push(MRL_GUIDANCE);
  if (set.has('crl')) guidance.push(CRL_GUIDANCE);
  if (set.has('churchill')) guidance.push(CHURCHILL_GUIDANCE);
  if (guidance.length) parts.push('Primary-signal guidance:\n' + guidance.join('\n'));

  parts.push('Client information:\n' + (opts.inputBlob || '(no inputs provided)'));

  const prior = priorBlock(dims, opts.prior);
  if (prior) parts.push(prior);

  return { system: SCORE_SYSTEM_PROMPT, user: parts.join('\n\n') };
}

// ── Parse / clamp the model's raw JSON into a StageScore ───────────────────────

const clampInt = (v: unknown, min: number, max: number): number | undefined => {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
};

/** Validate + clamp the raw model output into a StageScore for the given path. Returns null if a
 *  required score is missing/non-numeric. Enforces sub-stage = N/A unless the stage is 3. */
export function parseScoreResult(
  raw: Record<string, unknown> | null,
  path: ScoringPath,
  model: string,
  rescore: boolean,
): StageScore | null {
  if (!raw) return null;
  const set = new Set(PATH_DIMENSIONS[path]);
  const out: StageScore = { path, rescore, model };

  if (set.has('trl')) { out.trl = clampInt(raw.trl, DIM_RANGE.trl.min, DIM_RANGE.trl.max); if (out.trl == null) return null; }
  if (set.has('mrl')) { out.mrl = clampInt(raw.mrl, DIM_RANGE.mrl.min, DIM_RANGE.mrl.max); if (out.mrl == null) return null; }
  if (set.has('crl')) { out.crl = clampInt(raw.crl, DIM_RANGE.crl.min, DIM_RANGE.crl.max); if (out.crl == null) return null; }
  if (set.has('trl') || set.has('mrl') || set.has('crl')) {
    out.techRationale = valueToText(raw.tech_rationale) || undefined;
  }
  if (set.has('churchill')) {
    out.churchillStage = clampInt(raw.churchill_score, DIM_RANGE.churchill.min, DIM_RANGE.churchill.max);
    if (out.churchillStage == null) return null;
    const sub = valueToText(raw.churchill_substage);
    // Sub-stage only applies at stage 3; force N/A otherwise regardless of what the model emitted.
    out.churchillSubstage = out.churchillStage === 3 && (sub === 'III-D' || sub === 'III-G') ? sub : 'N/A';
    out.serviceRationale = valueToText(raw.service_rationale) || undefined;
  }
  return out;
}

// ── Public entry point ─────────────────────────────────────────────────────────

export interface ScoreCompanyOptions {
  /** Company field accessor (bare or prefixed keys), e.g. readRecordFields('business', id).get. */
  field: (key: string) => unknown;
  /** Path from routePath(field('business.business_model')). */
  path: ScoringPath;
  /** Prior assessment → triggers the re-score variant. Omit/null for initial. */
  prior?: PriorAssessment | null;
  /** Model override (default SCORING_MODEL). */
  model?: string;
  /** Max output tokens (default 4000). The both-path emits two full rationales (~2100 tokens typically,
   *  but output length varies run-to-run since Sonnet 5 dropped `temperature`); too low a cap truncates
   *  the structured output to empty and the run drops the company. Only generated tokens are billed. */
  maxTokens?: number;
}

/**
 * Score one company in a single consolidated Claude call. Returns null when Claude is unconfigured,
 * there are no inputs to score from, or the model output is unusable. Does NOT write anything.
 */
export async function scoreCompany(opts: ScoreCompanyOptions): Promise<StageScore | null> {
  if (!hasAnthropic) return null;
  const dims = PATH_DIMENSIONS[opts.path];
  const inputBlob = buildInputBlob(opts.field, dims);
  if (!inputBlob.trim()) return null;

  const model = opts.model ?? SCORING_MODEL;
  const { system, user } = buildScorePrompt({ path: opts.path, inputBlob, prior: opts.prior });
  const schema = buildScoreSchema(dims);

  const raw = await classifyJson<Record<string, unknown>>({
    system,
    user,
    schema,
    model,
    maxTokens: opts.maxTokens ?? 4000,
  });
  return parseScoreResult(raw, opts.path, model, Boolean(opts.prior));
}
