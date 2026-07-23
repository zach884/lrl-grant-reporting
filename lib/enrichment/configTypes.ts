// lib/enrichment/configTypes.ts — config-as-data contract for an enricher's GATE (GROUPS of FILTERS).
//
// Enrichers themselves stay in CODE (the AI prompt/taxonomy, deriveStops, coercion). Only WHEN/WHERE
// an enricher runs is config: a two-level boolean of FILTERS. Each filter is "run only when <field>
// is one of <anyOf>". Filters are combined inside a GROUP (AND/OR), and groups are combined at the
// top level (AND/OR) — so you can express e.g. status ∈ {Approved} AND (tag ∋ {Team} OR {EIR}), or
// (A AND B) OR (C AND D). Add/remove groups + filters freely; an empty gate = always run.
// Kept in its own module (no db/enrichment imports) so lib/db/schema.ts can type the jsonb columns.

/** One filter: passes when the record's `field` value is (or contains) one of `anyOf`. */
export interface EnricherFilter {
  field: string;
  anyOf: string[];
}

/** How things combine. AND = every child must pass; OR = any one. */
export type FilterCombine = 'AND' | 'OR';

/** A group of filters combined by `combine`. Groups are the unit the top-level combine joins. */
export interface EnricherGroup {
  combine: FilterCombine;
  filters: EnricherFilter[];
}

/** The resolved gate config for one enricher (a DB row, or a code default when no row exists). */
export interface EnricherConfig {
  enricher: string;
  sourceObject: string;
  enabled: boolean;
  /** Ordered list of groups. Empty (or all groups empty) => no restriction (always run). */
  groups: EnricherGroup[];
  /** How the GROUPS combine at the top level. Defaults to AND. */
  combine: FilterCombine;
}

/** Config input for an upsert (version/updatedAt assigned by the store). */
export type EnricherConfigInput = Omit<EnricherConfig, never>;

// ── Legacy shapes (pre-filters) — kept only to type the old jsonb columns + back-compat reads. ──
/** @deprecated superseded by EnricherFilter. */
export interface EnricherStatusGate { field: string; runOn: string[] }
/** @deprecated superseded by EnricherFilter. */
export interface EnricherMembership { field: string; anyOf: string[] }
