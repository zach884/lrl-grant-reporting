// lib/enrichment/gate.ts — pure evaluation of an enricher's FILTERS.
//
// An enricher runs when its filters are satisfied. Each filter is "field is one of anyOf" (values
// within a filter are OR'd); filters are combined with a top-level AND or OR. An empty filter list
// means "always run". This is the single source of truth used by every caller that runs an enricher
// (the /api/sync/up pipeline, the company engine, /api/readiness-tag, the CLI) so they all agree.
// No DB, no I/O — just the record's values + the config.

import type { EnricherConfig, EnricherFilter } from './configTypes';

/** Normalize a possibly-array / delimited value into a lowercased string set. */
function toValueSet(value: unknown): Set<string> {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(/[,;]/);
  return new Set(parts.map((v) => String(v).trim().toLowerCase()).filter(Boolean));
}

/** True when `value` (array or delimited string) contains any of `anyOf`. Empty anyOf => always. Case-insensitive. */
export function membershipMatches(value: unknown, anyOf?: string[] | null): boolean {
  if (!anyOf || anyOf.length === 0) return true;
  const have = toValueSet(value);
  return anyOf.some((v) => have.has(String(v).trim().toLowerCase()));
}

/** A single filter passes when the record's field value is/contains one of anyOf. Empty filter => passes. */
export function passesFilter(read: (key: string) => unknown, filter: EnricherFilter): boolean {
  if (!filter?.field || !filter.anyOf?.length) return true;
  return membershipMatches(read(filter.field), filter.anyOf);
}

export interface GateDecision {
  run: boolean;
  /** Human-readable reason when run=false (for logs/notes). */
  reason?: string;
}

/** Only the filters that are actually configured (have a field + at least one value). */
export function activeFilters(config: Pick<EnricherConfig, 'filters'>): EnricherFilter[] {
  return (config.filters ?? []).filter((f) => f?.field && f.anyOf?.length);
}

/**
 * Decide whether an enricher should run for a record, from its filters + combine.
 * `read` resolves a source field key to its value (e.g. readContactField bound to the record).
 * enabled=false short-circuits to run=false; no active filters => run=true.
 */
export function evaluateGate(read: (key: string) => unknown, config: EnricherConfig): GateDecision {
  if (!config.enabled) return { run: false, reason: 'enricher disabled' };

  const active = activeFilters(config);
  if (active.length === 0) return { run: true };

  const combine = config.combine === 'OR' ? 'OR' : 'AND';
  const results = active.map((f) => ({ f, pass: passesFilter(read, f) }));
  const run = combine === 'OR' ? results.some((r) => r.pass) : results.every((r) => r.pass);
  if (run) return { run: true };

  const failed = results.filter((r) => !r.pass).map((r) => `${r.f.field}∉{${r.f.anyOf.join(',')}}`);
  return { run: false, reason: `filters (${combine}) not satisfied: ${failed.join(combine === 'OR' ? ' or ' : ' & ')}` };
}

/** Generic alias — the same evaluation works for any object (company or contact). */
export const evaluateContactGate = evaluateGate;
