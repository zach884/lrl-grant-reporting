// Unit tests for the enricher-config READ path (code-default fallback + legacy back-compat) and the
// input sanitizer. The engine calls resolveEnricherConfig, which returns the stored row's filters
// when present, else synthesizes filters from the deprecated gate/membership columns, else the code
// default — so a missing row / old row / missing DB all reproduce the intended behavior.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ENRICHER_CONFIGS,
  defaultEnricherConfig,
  configFromRow,
  sanitizeEnricherConfigInput,
} from '../configStore';
import type { EnricherConfigRow } from '../../db/schema';

describe('code defaults', () => {
  it('seeds the readiness tagger as two ANDed filters (Approved + Team/EIR) — cutover no-op', () => {
    const d = DEFAULT_ENRICHER_CONFIGS['readiness-tagger::contact'];
    expect(d.combine).toBe('AND');
    expect(d.filters).toEqual([
      { field: 'contact.status', anyOf: ['Approved'] },
      { field: 'contact.website_team_tags', anyOf: ['Team', 'EIR'] },
    ]);
  });

  it('an unknown enricher falls back to a permissive always-run config (no filters)', () => {
    expect(defaultEnricherConfig('mystery', 'contact')).toEqual({ enricher: 'mystery', sourceObject: 'contact', enabled: true, filters: [], combine: 'AND' });
  });
});

describe('configFromRow (read fallback + back-compat)', () => {
  it('returns the CODE DEFAULT when there is no row', () => {
    expect(configFromRow(null, 'readiness-tagger', 'contact')).toEqual(DEFAULT_ENRICHER_CONFIGS['readiness-tagger::contact']);
  });

  it('prefers the filters column when present', () => {
    const row = { enricher: 'readiness-tagger', sourceObject: 'contact', enabled: true, combine: 'OR', filters: [{ field: 'contact.status', anyOf: ['Approved', 'Published'] }], gate: null, membership: null } as EnricherConfigRow;
    const c = configFromRow(row, 'readiness-tagger', 'contact');
    expect(c.combine).toBe('OR');
    expect(c.filters).toEqual([{ field: 'contact.status', anyOf: ['Approved', 'Published'] }]);
  });

  it('back-compat: synthesizes filters from legacy gate + membership columns (ANDed)', () => {
    const row = { enricher: 'readiness-tagger', sourceObject: 'contact', enabled: true, combine: null, filters: null, gate: { field: 'contact.status', runOn: ['Approved'] }, membership: { field: 'contact.website_team_tags', anyOf: ['Team', 'EIR'] } } as unknown as EnricherConfigRow;
    const c = configFromRow(row, 'readiness-tagger', 'contact');
    expect(c.combine).toBe('AND');
    expect(c.filters).toEqual([
      { field: 'contact.status', anyOf: ['Approved'] },
      { field: 'contact.website_team_tags', anyOf: ['Team', 'EIR'] },
    ]);
  });

  it('empty filters column => always-run', () => {
    const row = { enricher: 'x', sourceObject: 'contact', enabled: true, combine: 'AND', filters: [] as unknown[], gate: null, membership: null } as unknown as EnricherConfigRow;
    expect(configFromRow(row, 'x', 'contact').filters).toEqual([]);
  });
});

describe('sanitizeEnricherConfigInput', () => {
  it('cleans filters (trims, drops empties/fieldless) and defaults combine to AND', () => {
    const input = sanitizeEnricherConfigInput({
      enabled: true,
      combine: 'bogus',
      filters: [{ field: ' contact.status ', anyOf: [' Approved ', ''] }, { field: '', anyOf: ['x'] }, { field: 'f', anyOf: [] }],
    }, 'readiness-tagger', 'contact');
    expect(input.combine).toBe('AND');
    expect(input.filters).toEqual([{ field: 'contact.status', anyOf: ['Approved'] }, { field: 'f', anyOf: [] }]);
    expect(input.enricher).toBe('readiness-tagger');
  });

  it('honors combine=OR and enabled=false', () => {
    const input = sanitizeEnricherConfigInput({ enabled: false, combine: 'OR', filters: [] }, 'x', 'contact');
    expect(input).toEqual({ enricher: 'x', sourceObject: 'contact', enabled: false, filters: [], combine: 'OR' });
  });
});
