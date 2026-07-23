// lib/enrichment/gate.ts — pure evaluation of an enricher's status + membership gates.
//
// Both gates share the sync gate's "field + values" idea. These are the single source of truth used
// by every caller that runs a contact enricher (the /api/sync/up pipeline, the /api/readiness-tag
// webhook, and the CLI) so they all decide identically. No DB, no I/O — just the values + the config.

import type { EnricherConfig, EnricherMembership, EnricherStatusGate } from './configTypes';

/** Normalize a possibly-array / delimited value into a lowercased string set. */
function toValueSet(value: unknown): Set<string> {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(/[,;]/);
  return new Set(parts.map((v) => String(v).trim().toLowerCase()).filter(Boolean));
}

/**
 * Status gate: passes when `value` equals one of `runOn`. An empty/absent runOn list means "always"
 * (no status restriction). Case-insensitive, matching how gate values are compared elsewhere.
 */
export function passesStatusGate(value: unknown, runOn?: string[] | null): boolean {
  if (!runOn || runOn.length === 0) return true;
  const want = new Set(runOn.map((s) => String(s).trim().toLowerCase()));
  return want.has(String(value ?? '').trim().toLowerCase());
}

/**
 * Membership gate: passes when `value` (array or delimited string) contains any of `anyOf`. An
 * empty/absent anyOf list means "always". Case-insensitive.
 */
export function membershipMatches(value: unknown, anyOf?: string[] | null): boolean {
  if (!anyOf || anyOf.length === 0) return true;
  const have = toValueSet(value);
  return anyOf.some((v) => have.has(String(v).trim().toLowerCase()));
}

export interface GateDecision {
  run: boolean;
  /** Human-readable reason when run=false (for logs/notes). */
  reason?: string;
}

/**
 * Decide whether an enricher should run for a record, using its config's status + membership gates.
 * `read` resolves a source field key to its value (e.g. readContactField bound to the record).
 * `config.enabled=false` short-circuits to run=false.
 */
export function evaluateContactGate(read: (key: string) => unknown, config: EnricherConfig): GateDecision {
  if (!config.enabled) return { run: false, reason: 'enricher disabled' };

  const gate: EnricherStatusGate | null = config.gate;
  if (gate?.field && gate.runOn?.length) {
    const status = read(gate.field);
    if (!passesStatusGate(status, gate.runOn)) {
      return { run: false, reason: `status "${String(status ?? '')}" not in {${gate.runOn.join(',')}}` };
    }
  }

  const membership: EnricherMembership | null = config.membership;
  if (membership?.field && membership.anyOf?.length) {
    const value = read(membership.field);
    if (!membershipMatches(value, membership.anyOf)) {
      return { run: false, reason: `membership not in {${membership.anyOf.join(',')}}` };
    }
  }

  return { run: true };
}

/** Generic alias — the same evaluation works for any object (company or contact). */
export const evaluateGate = evaluateContactGate;
