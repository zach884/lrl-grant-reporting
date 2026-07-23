// lib/enrichment/gate.ts — pure evaluation of an enricher's GATE (groups of filters).
//
// An enricher runs when its gate is satisfied. A filter is "field is one of anyOf" (values within a
// filter are OR'd). Filters combine inside a GROUP (AND/OR); groups combine at the top level (AND/OR)
// — a two-level boolean, e.g. status ∈ {Approved} AND (tag ∋ {Team} OR {EIR}). An empty gate (no
// groups, or all groups empty) means "always run". This is the single source of truth every caller
// uses (the /api/sync/up pipeline, the company engine, /api/readiness-tag, the CLI). No DB, no I/O.

import type { EnricherConfig, EnricherFilter, EnricherGroup } from './configTypes';

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

/** The configured (non-empty) filters within a group. */
export function activeFiltersIn(group: EnricherGroup): EnricherFilter[] {
  return (group?.filters ?? []).filter((f) => f?.field && f.anyOf?.length);
}

/** Groups that actually constrain anything (have ≥1 active filter). */
export function activeGroups(config: Pick<EnricherConfig, 'groups'>): EnricherGroup[] {
  return (config.groups ?? []).filter((g) => activeFiltersIn(g).length > 0);
}

/** A group passes when its filters satisfy the group's combine (AND=every, OR=any). */
function groupPasses(read: (key: string) => unknown, group: EnricherGroup): boolean {
  const fs = activeFiltersIn(group);
  if (fs.length === 0) return true; // neutral (filtered out by activeGroups in practice)
  return (group.combine === 'OR' ? fs.some : fs.every).call(fs, (f: EnricherFilter) => passesFilter(read, f));
}

export interface GateDecision {
  run: boolean;
  /** Human-readable reason when run=false (for logs/notes). */
  reason?: string;
}

function describeGroup(g: EnricherGroup): string {
  const parts = activeFiltersIn(g).map((f) => `${f.field}∈{${f.anyOf.join(',')}}`);
  return parts.length > 1 ? `(${parts.join(g.combine === 'OR' ? ' or ' : ' & ')})` : parts.join('');
}

/**
 * Decide whether an enricher should run for a record, from its groups + top-level combine.
 * `read` resolves a source field key to its value (e.g. readContactField bound to the record).
 * enabled=false short-circuits to run=false; no active groups => run=true.
 */
export function evaluateGate(read: (key: string) => unknown, config: EnricherConfig): GateDecision {
  if (!config.enabled) return { run: false, reason: 'enricher disabled' };

  const groups = activeGroups(config);
  if (groups.length === 0) return { run: true };

  const top = config.combine === 'OR' ? 'OR' : 'AND';
  const results = groups.map((g) => ({ g, pass: groupPasses(read, g) }));
  const run = top === 'OR' ? results.some((r) => r.pass) : results.every((r) => r.pass);
  if (run) return { run: true };

  const failed = results.filter((r) => !r.pass).map((r) => describeGroup(r.g));
  return { run: false, reason: `gate (${top}) not satisfied: ${failed.join(top === 'OR' ? ' or ' : ' & ')}` };
}

/** Generic alias — the same evaluation works for any object (company or contact). */
export const evaluateContactGate = evaluateGate;
