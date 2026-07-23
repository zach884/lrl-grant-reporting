// Unit tests for the enricher-config READ path (the code-default fallback) + input sanitizers.
// The engine calls resolveEnricherConfig, which returns the stored row when present and otherwise the
// code default — so a missing row / missing DB reproduces today's behavior. configFromRow is the pure
// core of that read; here we prove the fallback + row mapping without a live DB.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ENRICHER_CONFIGS,
  defaultEnricherConfig,
  configFromRow,
  sanitizeStatusGate,
  sanitizeMembership,
  sanitizeEnricherConfigInput,
} from '../configStore';
import type { EnricherConfigRow } from '../../db/schema';

describe('code defaults', () => {
  it('seeds the readiness tagger gate = Approved + Team/EIR (cutover no-op)', () => {
    const d = DEFAULT_ENRICHER_CONFIGS['readiness-tagger::contact'];
    expect(d.gate).toEqual({ field: 'contact.status', runOn: ['Approved'] });
    expect(d.membership).toEqual({ field: 'contact.website_team_tags', anyOf: ['Team', 'EIR'] });
    expect(d.enabled).toBe(true);
  });

  it('an unknown enricher falls back to a permissive always-run config', () => {
    const d = defaultEnricherConfig('mystery', 'contact');
    expect(d).toEqual({ enricher: 'mystery', sourceObject: 'contact', enabled: true, gate: null, membership: null });
  });
});

describe('configFromRow (the read fallback)', () => {
  it('returns the CODE DEFAULT when there is no row (missing DB / unseeded)', () => {
    expect(configFromRow(null, 'readiness-tagger', 'contact')).toEqual(DEFAULT_ENRICHER_CONFIGS['readiness-tagger::contact']);
  });

  it('maps a stored row (an edited gate) over the default', () => {
    const row = {
      enricher: 'readiness-tagger', sourceObject: 'contact', enabled: true,
      gate: { field: 'contact.status', runOn: ['Approved', 'Published'] },
      membership: { field: 'contact.website_team_tags', anyOf: ['Team', 'EIR', 'Board'] },
    } as EnricherConfigRow;
    const c = configFromRow(row, 'readiness-tagger', 'contact');
    expect(c.gate?.runOn).toEqual(['Approved', 'Published']);
    expect(c.membership?.anyOf).toContain('Board');
  });

  it('null jsonb columns become null gates (always-run)', () => {
    const row = { enricher: 'x', sourceObject: 'contact', enabled: true, gate: null, membership: null } as EnricherConfigRow;
    const c = configFromRow(row, 'x', 'contact');
    expect(c.gate).toBeNull();
    expect(c.membership).toBeNull();
  });
});

describe('sanitizers', () => {
  it('sanitizeStatusGate: empty field or null → null; trims runOn', () => {
    expect(sanitizeStatusGate(null)).toBeNull();
    expect(sanitizeStatusGate({ field: '', runOn: ['Approved'] })).toBeNull();
    expect(sanitizeStatusGate({ field: 'contact.status', runOn: [' Approved ', '', 'Published'] })).toEqual({ field: 'contact.status', runOn: ['Approved', 'Published'] });
  });
  it('sanitizeMembership: empty field or null → null; trims anyOf', () => {
    expect(sanitizeMembership(null)).toBeNull();
    expect(sanitizeMembership({ field: 'contact.website_team_tags', anyOf: ['Team', ' EIR '] })).toEqual({ field: 'contact.website_team_tags', anyOf: ['Team', 'EIR'] });
  });
  it('sanitizeEnricherConfigInput assembles a clean input', () => {
    const input = sanitizeEnricherConfigInput({ enabled: false, gate: { field: 'contact.status', runOn: ['Approved'] }, membership: null }, 'readiness-tagger', 'contact');
    expect(input).toEqual({ enricher: 'readiness-tagger', sourceObject: 'contact', enabled: false, gate: { field: 'contact.status', runOn: ['Approved'] }, membership: null });
  });
});
