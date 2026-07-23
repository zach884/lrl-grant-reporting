// Unit tests for the pure enricher gate evaluation (lib/enrichment/gate.ts). This is the single
// source of truth every caller uses to decide whether to run a contact enricher, so it must match
// the pre-config behavior exactly (status=Approved + Team/EIR) and honor edited configs.

import { describe, it, expect } from 'vitest';
import { passesStatusGate, membershipMatches, evaluateContactGate } from '../gate';
import type { EnricherConfig } from '../configTypes';

describe('passesStatusGate', () => {
  it('is true when value ∈ runOn (case-insensitive), false otherwise', () => {
    expect(passesStatusGate('Approved', ['Approved'])).toBe(true);
    expect(passesStatusGate('approved', ['Approved'])).toBe(true);
    expect(passesStatusGate('Published', ['Approved'])).toBe(false);
    expect(passesStatusGate('', ['Approved'])).toBe(false);
  });
  it('empty / absent runOn means always-run', () => {
    expect(passesStatusGate('anything', [])).toBe(true);
    expect(passesStatusGate('anything', null)).toBe(true);
    expect(passesStatusGate(undefined, undefined)).toBe(true);
  });
});

describe('membershipMatches', () => {
  it('matches array or delimited string against anyOf (case-insensitive)', () => {
    expect(membershipMatches(['Team'], ['Team', 'EIR'])).toBe(true);
    expect(membershipMatches(['Board'], ['Team', 'EIR'])).toBe(false);
    expect(membershipMatches('Team, Board', ['team'])).toBe(true);
    expect(membershipMatches('Board;EIR', ['eir'])).toBe(true);
  });
  it('empty / absent anyOf means always-run', () => {
    expect(membershipMatches(['Board'], [])).toBe(true);
    expect(membershipMatches(undefined, null)).toBe(true);
  });
});

describe('evaluateContactGate', () => {
  const readinessDefault: EnricherConfig = {
    enricher: 'readiness-tagger', sourceObject: 'contact', enabled: true,
    gate: { field: 'contact.status', runOn: ['Approved'] },
    membership: { field: 'contact.website_team_tags', anyOf: ['Team', 'EIR'] },
  };
  const read = (vals: Record<string, unknown>) => (k: string) => vals[k];

  it('runs when status + membership both pass (today’s default behavior)', () => {
    const d = evaluateContactGate(read({ 'contact.status': 'Approved', 'contact.website_team_tags': ['Team'] }), readinessDefault);
    expect(d.run).toBe(true);
  });

  it('skips on a status miss, with a reason', () => {
    const d = evaluateContactGate(read({ 'contact.status': 'Pending', 'contact.website_team_tags': ['Team'] }), readinessDefault);
    expect(d.run).toBe(false);
    expect(d.reason).toContain('Pending');
  });

  it('skips a Board-only contact (membership miss)', () => {
    const d = evaluateContactGate(read({ 'contact.status': 'Approved', 'contact.website_team_tags': ['Board'] }), readinessDefault);
    expect(d.run).toBe(false);
    expect(d.reason).toContain('membership');
  });

  it('a UI edit that adds Published to runOn now lets a Published contact through', () => {
    const edited: EnricherConfig = { ...readinessDefault, gate: { field: 'contact.status', runOn: ['Approved', 'Published'] } };
    const d = evaluateContactGate(read({ 'contact.status': 'Published', 'contact.website_team_tags': ['EIR'] }), edited);
    expect(d.run).toBe(true);
  });

  it('disabled config never runs', () => {
    const d = evaluateContactGate(read({ 'contact.status': 'Approved', 'contact.website_team_tags': ['Team'] }), { ...readinessDefault, enabled: false });
    expect(d.run).toBe(false);
  });
});
