// Unit tests for the enricher-config READ path (code default + back-compat) and the input sanitizer.
// resolveEnricherConfig returns the stored row's groups when present, else wraps the pre-groups flat
// `filters` column as one group, else folds the legacy gate/membership columns into one group, else
// the code default — so every generation of row (and a missing DB) reproduces the intended behavior.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ENRICHER_CONFIGS,
  defaultEnricherConfig,
  configFromRow,
  sanitizeEnricherConfigInput,
} from '../configStore';
import type { EnricherConfigRow } from '../../db/schema';

const row = (o: Record<string, unknown>) => o as unknown as EnricherConfigRow;

describe('code defaults', () => {
  it('seeds readiness as one ANDed group [Approved, Team/EIR] — cutover no-op', () => {
    const d = DEFAULT_ENRICHER_CONFIGS['readiness-tagger::contact'];
    expect(d.combine).toBe('AND');
    expect(d.groups).toEqual([{ combine: 'AND', filters: [
      { field: 'contact.status', anyOf: ['Approved'] },
      { field: 'contact.website_team_tags', anyOf: ['Team', 'EIR'] },
    ] }]);
  });
  it('unknown enricher => permissive always-run (no groups)', () => {
    expect(defaultEnricherConfig('mystery', 'contact')).toEqual({ enricher: 'mystery', sourceObject: 'contact', enabled: true, groups: [], combine: 'AND' });
  });
});

describe('configFromRow — read precedence', () => {
  it('no row => code default', () => {
    expect(configFromRow(null, 'readiness-tagger', 'contact')).toEqual(DEFAULT_ENRICHER_CONFIGS['readiness-tagger::contact']);
  });

  it('prefers the groups column (two-level, top-level OR)', () => {
    const c = configFromRow(row({
      enricher: 'x', sourceObject: 'contact', enabled: true, combine: 'OR',
      groups: [
        { combine: 'AND', filters: [{ field: 'contact.status', anyOf: ['Approved'] }] },
        { combine: 'OR', filters: [{ field: 'contact.tag', anyOf: ['A', 'B'] }] },
      ],
      filters: null, gate: null, membership: null,
    }), 'x', 'contact');
    expect(c.combine).toBe('OR');
    expect(c.groups).toHaveLength(2);
    expect(c.groups[1].combine).toBe('OR');
  });

  it('back-compat: wraps the pre-groups flat filters column as ONE group (combine from the row)', () => {
    const c = configFromRow(row({
      enricher: 'x', sourceObject: 'contact', enabled: true, combine: 'OR',
      groups: null,
      filters: [{ field: 'contact.status', anyOf: ['Approved'] }, { field: 'contact.tag', anyOf: ['A'] }],
      gate: null, membership: null,
    }), 'x', 'contact');
    expect(c.combine).toBe('AND'); // single group => top-level combine is pinned to AND
    expect(c.groups).toEqual([{ combine: 'OR', filters: [{ field: 'contact.status', anyOf: ['Approved'] }, { field: 'contact.tag', anyOf: ['A'] }] }]);
  });

  it('back-compat: folds legacy gate + membership columns into one ANDed group', () => {
    const c = configFromRow(row({
      enricher: 'readiness-tagger', sourceObject: 'contact', enabled: true, combine: null, groups: null, filters: null,
      gate: { field: 'contact.status', runOn: ['Approved'] },
      membership: { field: 'contact.website_team_tags', anyOf: ['Team', 'EIR'] },
    }), 'readiness-tagger', 'contact');
    expect(c.groups).toEqual([{ combine: 'AND', filters: [
      { field: 'contact.status', anyOf: ['Approved'] },
      { field: 'contact.website_team_tags', anyOf: ['Team', 'EIR'] },
    ] }]);
  });
});

describe('sanitizeEnricherConfigInput', () => {
  it('cleans groups (trims, drops empty filters/groups) and defaults combine to AND', () => {
    const input = sanitizeEnricherConfigInput({
      enabled: true, combine: 'bogus',
      groups: [
        { combine: 'OR', filters: [{ field: ' contact.status ', anyOf: [' Approved ', ''] }, { field: '', anyOf: ['x'] }] },
        { combine: 'AND', filters: [{ field: '', anyOf: [] }] }, // fully empty group => dropped
      ],
    }, 'readiness-tagger', 'contact');
    expect(input.combine).toBe('AND');
    expect(input.groups).toEqual([{ combine: 'OR', filters: [{ field: 'contact.status', anyOf: ['Approved'] }] }]);
  });

  it('accepts a flat filters array and wraps it as one group', () => {
    const input = sanitizeEnricherConfigInput({ enabled: false, combine: 'OR', filters: [{ field: 'f', anyOf: ['v'] }] }, 'x', 'contact');
    expect(input.enabled).toBe(false);
    expect(input.groups).toEqual([{ combine: 'OR', filters: [{ field: 'f', anyOf: ['v'] }] }]);
  });
});
