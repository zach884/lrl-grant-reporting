// lib/enrichment/configTypes.ts — config-as-data contract for an enricher's GATE (a set of FILTERS).
//
// Enrichers themselves stay in CODE (the AI prompt/taxonomy, deriveStops, coercion). Only WHEN/WHERE
// an enricher runs is config: a list of FILTERS, each "run only when <field> is one of <anyOf>",
// combined with a top-level AND / OR. e.g. readiness = [contact.status ∈ {Approved}] AND
// [contact.website_team_tags ∋ {Team,EIR}]. Add/remove filters freely; an empty list = always run.
// Kept in its own module (no db/enrichment imports) so lib/db/schema.ts can type the jsonb columns.

/** One filter: passes when the record's `field` value is (or contains) one of `anyOf`. */
export interface EnricherFilter {
  field: string;
  anyOf: string[];
}

/** How multiple filters combine. AND = every filter must pass; OR = any one. */
export type FilterCombine = 'AND' | 'OR';

/** The resolved gate config for one enricher (a DB row, or a code default when no row exists). */
export interface EnricherConfig {
  enricher: string;
  sourceObject: string;
  enabled: boolean;
  /** Ordered list of filters. Empty => no restriction (always run). */
  filters: EnricherFilter[];
  /** How the filters combine. Defaults to AND. */
  combine: FilterCombine;
}

/** Config input for an upsert (version/updatedAt assigned by the store). */
export type EnricherConfigInput = Omit<EnricherConfig, never>;

// ── Legacy shapes (pre-filters) — kept only to type the old jsonb columns + back-compat reads. ──
/** @deprecated superseded by EnricherFilter. */
export interface EnricherStatusGate { field: string; runOn: string[] }
/** @deprecated superseded by EnricherFilter. */
export interface EnricherMembership { field: string; anyOf: string[] }
