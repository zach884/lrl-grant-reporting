// Unit tests for the pure enricher gate evaluation (lib/enrichment/gate.ts) — the FILTERS model.
// Every caller uses evaluateGate to decide whether to run an enricher, so it must match the
// pre-config behavior (status=Approved AND Team/EIR) and honor edited filters + AND/OR.

import { describe, it, expect } from 'vitest';
import { membershipMatches, passesFilter, evaluateGate } from '../gate';
import type { EnricherConfig } from '../configTypes';

describe('membershipMatches', () => {
  it('matches array or delimited string against anyOf (case-insensitive)', () => {
    expect(membershipMatches(['Team'], ['Team', 'EIR'])).toBe(true);
    expect(membershipMatches(['Board'], ['Team', 'EIR'])).toBe(false);
    expect(membershipMatches('Team, Board', ['team'])).toBe(true);
    expect(membershipMatches('Approved', ['approved'])).toBe(true); // scalar status works too
  });
  it('empty / absent anyOf means always-match', () => {
    expect(membershipMatches(['Board'], [])).toBe(true);
    expect(membershipMatches(undefined, null)).toBe(true);
  });
});

describe('passesFilter', () => {
  const read = (v: Record<string, unknown>) => (k: string) => v[k];
  it('passes when the field value is one of anyOf', () => {
    expect(passesFilter(read({ 'contact.status': 'Approved' }), { field: 'contact.status', anyOf: ['Approved'] })).toBe(true);
    expect(passesFilter(read({ 'contact.status': 'Pending' }), { field: 'contact.status', anyOf: ['Approved'] })).toBe(false);
  });
  it('an empty filter always passes', () => {
    expect(passesFilter(read({}), { field: '', anyOf: [] })).toBe(true);
    expect(passesFilter(read({}), { field: 'x', anyOf: [] })).toBe(true);
  });
});

describe('evaluateGate', () => {
  const readinessDefault: EnricherConfig = {
    enricher: 'readiness-tagger', sourceObject: 'contact', enabled: true, combine: 'AND',
    filters: [
      { field: 'contact.status', anyOf: ['Approved'] },
      { field: 'contact.website_team_tags', anyOf: ['Team', 'EIR'] },
    ],
  };
  const read = (vals: Record<string, unknown>) => (k: string) => vals[k];

  it('AND: runs only when every filter passes (today’s default)', () => {
    expect(evaluateGate(read({ 'contact.status': 'Approved', 'contact.website_team_tags': ['Team'] }), readinessDefault).run).toBe(true);
    expect(evaluateGate(read({ 'contact.status': 'Pending', 'contact.website_team_tags': ['Team'] }), readinessDefault).run).toBe(false);
    expect(evaluateGate(read({ 'contact.status': 'Approved', 'contact.website_team_tags': ['Board'] }), readinessDefault).run).toBe(false);
  });

  it('OR: runs when any filter passes', () => {
    const orCfg: EnricherConfig = { ...readinessDefault, combine: 'OR' };
    expect(evaluateGate(read({ 'contact.status': 'Pending', 'contact.website_team_tags': ['Team'] }), orCfg).run).toBe(true);
    expect(evaluateGate(read({ 'contact.status': 'Pending', 'contact.website_team_tags': ['Board'] }), orCfg).run).toBe(false);
  });

  it('no filters => always runs', () => {
    expect(evaluateGate(read({}), { ...readinessDefault, filters: [] }).run).toBe(true);
  });

  it('adding a value to a filter (a UI edit) changes the decision', () => {
    const edited: EnricherConfig = { ...readinessDefault, filters: [{ field: 'contact.status', anyOf: ['Approved', 'Published'] }, readinessDefault.filters[1]] };
    expect(evaluateGate(read({ 'contact.status': 'Published', 'contact.website_team_tags': ['EIR'] }), edited).run).toBe(true);
  });

  it('disabled config never runs', () => {
    expect(evaluateGate(read({ 'contact.status': 'Approved', 'contact.website_team_tags': ['Team'] }), { ...readinessDefault, enabled: false }).run).toBe(false);
  });

  it('reason names the failed filters', () => {
    const d = evaluateGate(read({ 'contact.status': 'Pending', 'contact.website_team_tags': ['Board'] }), readinessDefault);
    expect(d.run).toBe(false);
    expect(d.reason).toContain('contact.status');
  });
});
