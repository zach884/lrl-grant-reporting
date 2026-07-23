// Unit tests for the pure enricher gate evaluation (lib/enrichment/gate.ts) — the GROUPS model.
// Filters combine inside a group; groups combine at the top level. Must match the pre-config default
// (status=Approved AND Team/EIR) and honor two-level boolean edits like A AND (B OR C).

import { describe, it, expect } from 'vitest';
import { membershipMatches, passesFilter, evaluateGate } from '../gate';
import type { EnricherConfig } from '../configTypes';

const read = (vals: Record<string, unknown>) => (k: string) => vals[k];

describe('membershipMatches / passesFilter', () => {
  it('matches array or delimited string against anyOf (case-insensitive)', () => {
    expect(membershipMatches(['Team'], ['Team', 'EIR'])).toBe(true);
    expect(membershipMatches(['Board'], ['Team', 'EIR'])).toBe(false);
    expect(membershipMatches('Approved', ['approved'])).toBe(true);
  });
  it('passesFilter: field ∈ anyOf; empty filter always passes', () => {
    expect(passesFilter(read({ 'contact.status': 'Approved' }), { field: 'contact.status', anyOf: ['Approved'] })).toBe(true);
    expect(passesFilter(read({ 'contact.status': 'Pending' }), { field: 'contact.status', anyOf: ['Approved'] })).toBe(false);
    expect(passesFilter(read({}), { field: 'x', anyOf: [] })).toBe(true);
  });
});

const readinessDefault: EnricherConfig = {
  enricher: 'readiness-tagger', sourceObject: 'contact', enabled: true, combine: 'AND',
  groups: [{ combine: 'AND', filters: [
    { field: 'contact.status', anyOf: ['Approved'] },
    { field: 'contact.website_team_tags', anyOf: ['Team', 'EIR'] },
  ] }],
};

describe('evaluateGate — single group (today’s default)', () => {
  it('AND within the group: every filter must pass', () => {
    expect(evaluateGate(read({ 'contact.status': 'Approved', 'contact.website_team_tags': ['Team'] }), readinessDefault).run).toBe(true);
    expect(evaluateGate(read({ 'contact.status': 'Pending', 'contact.website_team_tags': ['Team'] }), readinessDefault).run).toBe(false);
    expect(evaluateGate(read({ 'contact.status': 'Approved', 'contact.website_team_tags': ['Board'] }), readinessDefault).run).toBe(false);
  });
  it('no groups => always runs', () => {
    expect(evaluateGate(read({}), { ...readinessDefault, groups: [] }).run).toBe(true);
  });
  it('disabled never runs', () => {
    expect(evaluateGate(read({ 'contact.status': 'Approved', 'contact.website_team_tags': ['Team'] }), { ...readinessDefault, enabled: false }).run).toBe(false);
  });
});

describe('evaluateGate — two-level grouping', () => {
  // A AND (B OR C): status ∈ {Approved} AND (tags ∋ {Team} OR status ∈ {Published})
  const cfg: EnricherConfig = {
    enricher: 'x', sourceObject: 'contact', enabled: true, combine: 'AND',
    groups: [
      { combine: 'AND', filters: [{ field: 'contact.status', anyOf: ['Approved', 'Published'] }] },
      { combine: 'OR', filters: [
        { field: 'contact.website_team_tags', anyOf: ['Team'] },
        { field: 'contact.plan', anyOf: ['Pro'] },
      ] },
    ],
  };
  it('passes when group1 AND group2(OR) are satisfied', () => {
    expect(evaluateGate(read({ 'contact.status': 'Approved', 'contact.website_team_tags': ['Team'] }), cfg).run).toBe(true);
    expect(evaluateGate(read({ 'contact.status': 'Published', 'contact.plan': 'Pro', 'contact.website_team_tags': ['Board'] }), cfg).run).toBe(true);
  });
  it('fails when the OR group has neither value', () => {
    expect(evaluateGate(read({ 'contact.status': 'Approved', 'contact.website_team_tags': ['Board'], 'contact.plan': 'Free' }), cfg).run).toBe(false);
  });
  it('fails when the AND group fails even if the OR group passes', () => {
    expect(evaluateGate(read({ 'contact.status': 'Pending', 'contact.website_team_tags': ['Team'] }), cfg).run).toBe(false);
  });

  it('top-level OR across groups: (A AND B) OR (C AND D)', () => {
    const orCfg: EnricherConfig = { ...cfg, combine: 'OR' };
    expect(evaluateGate(read({ 'contact.status': 'Pending', 'contact.website_team_tags': ['Team'] }), orCfg).run).toBe(true); // group2 passes
    expect(evaluateGate(read({ 'contact.status': 'Pending', 'contact.website_team_tags': ['Board'], 'contact.plan': 'Free' }), orCfg).run).toBe(false);
  });

  it('empty groups are ignored (a group with no active filters does not force/deny the run)', () => {
    const withEmpty: EnricherConfig = { ...readinessDefault, groups: [...readinessDefault.groups, { combine: 'AND', filters: [{ field: '', anyOf: [] }] }] };
    expect(evaluateGate(read({ 'contact.status': 'Approved', 'contact.website_team_tags': ['Team'] }), withEmpty).run).toBe(true);
  });
});
