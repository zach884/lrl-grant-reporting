// lib/enrichment/configTypes.ts — config-as-data contract for an enricher's GATE.
//
// Enrichers themselves stay in CODE (the AI prompt/taxonomy, deriveStops, coercion). Only WHEN/WHERE
// an enricher runs is config: a status gate (run only when the source record's status is in `runOn`)
// and a membership gate (run only when a field contains one of `anyOf`). Both reuse the same "field +
// values" shape as the sync gate. Kept in its own module (no db/enrichment imports) so lib/db/schema.ts
// can type the jsonb columns without a cycle.

/** Status gate: run the enricher only when the record's `field` value is in `runOn`. Empty/absent runOn = always. */
export interface EnricherStatusGate {
  field: string;
  runOn: string[];
}

/** Membership gate: run only when the record's `field` contains any of `anyOf` (case-insensitive). Empty/absent = always. */
export interface EnricherMembership {
  field: string;
  anyOf: string[];
}

/** The resolved gate config for one enricher (a DB row, or a code default when no row exists). */
export interface EnricherConfig {
  enricher: string;
  sourceObject: string;
  enabled: boolean;
  gate: EnricherStatusGate | null;
  membership: EnricherMembership | null;
}

/** Config input for an upsert (version/updatedAt assigned by the store). */
export type EnricherConfigInput = Omit<EnricherConfig, never>;
