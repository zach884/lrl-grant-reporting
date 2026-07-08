import { describe, it, expect } from 'vitest';
import { countyRawToLabel } from '../enrichers/county';
import { runEnrichers, applyProposals, deriveAddress } from '../engine';
import type { Enricher, EnrichmentProposal } from '../types';
import type { BusinessRecord, CustomFieldCatalog, CustomFieldDef } from '../../ghl/types';

function cat(fields: CustomFieldDef[]): CustomFieldCatalog {
  const byKey: Record<string, CustomFieldDef> = {};
  const byId: Record<string, CustomFieldDef> = {};
  for (const f of fields) { byKey[f.fieldKey] = f; byId[f.id] = f; }
  return { fields, folders: [], byKey, byId };
}

const countyOpts = [
  { key: 'jackson_county_mi', label: 'Jackson County (MI)' },
  { key: 'other', label: 'Other' },
];
const catalog = cat([
  { id: 'co', name: 'County', fieldKey: 'business.county', dataType: 'SINGLE_OPTIONS', options: countyOpts },
  { id: 'ms', name: 'Selling', fieldKey: 'business.i_am_selling', dataType: 'MULTIPLE_OPTIONS' },
]);

describe('countyRawToLabel', () => {
  it('maps a MI county name to the option label', () => {
    expect(countyRawToLabel('Jackson County', 'MI', countyOpts)).toBe('Jackson County (MI)');
    expect(countyRawToLabel('Jackson', 'MI', countyOpts)).toBe('Jackson County (MI)');
  });
  it('non-MI state -> Other', () => {
    expect(countyRawToLabel('Cook County', 'IL', countyOpts)).toBe('Other');
  });
  it('unknown MI county with an option list -> Other', () => {
    expect(countyRawToLabel('Nowhere County', 'MI', countyOpts)).toBe('Other');
  });
  it('no option list -> constructs the candidate label', () => {
    expect(countyRawToLabel('Ingham', 'MI', undefined)).toBe('Ingham County (MI)');
  });
  it('null raw -> null', () => {
    expect(countyRawToLabel(null, 'MI', countyOpts)).toBeNull();
  });
});

describe('deriveAddress', () => {
  it('reads address fields from company properties (multiple spellings)', () => {
    const company: BusinessRecord = { id: 'c', properties: { city: 'Jackson', state: 'MI', postalcode: '49201' } };
    expect(deriveAddress(company)).toEqual({ address1: undefined, city: 'Jackson', state: 'MI', postalCode: '49201' });
  });
});

function mockEnricher(name: string, key: string, value: unknown, confidence: number): Enricher {
  return { name, produces: [key], async enrich() {
    return [{ businessKey: key, value, provenance: { source: name, method: 'computed', confidence, timestamp: '2026-07-07T00:00:00Z' } }] as EnrichmentProposal[];
  } };
}

describe('runEnrichers dedupe', () => {
  it('keeps the highest-confidence proposal per field', async () => {
    const company: BusinessRecord = { id: 'c', properties: {} };
    const props = await runEnrichers(company, catalog, [
      mockEnricher('a', 'business.county', 'Other', 0.5),
      mockEnricher('b', 'business.county', 'Jackson County (MI)', 0.9),
    ]);
    expect(props).toHaveLength(1);
    expect(props[0].value).toBe('Jackson County (MI)');
  });
});

describe('applyProposals policy', () => {
  const proposal = (key: string, value: unknown, confidence = 0.9): EnrichmentProposal => ({
    businessKey: key, value, provenance: { source: 't', method: 'computed', confidence, timestamp: '2026-07-07T00:00:00Z' },
  });

  it('fill-empty skips fields that already have a value', async () => {
    const company: BusinessRecord = { id: 'c', properties: { county: 'Jackson County (MI)' } };
    const r = await applyProposals('c', company, [proposal('business.county', 'Other')], catalog, { mode: 'fill-empty' }, { apply: false });
    expect(r.applied).toHaveLength(0);
    expect(r.skipped[0].reason).toContain('already set');
  });

  it('overwrite applies even when set', async () => {
    const company: BusinessRecord = { id: 'c', properties: { county: 'Other' } };
    const r = await applyProposals('c', company, [proposal('business.county', 'Jackson County (MI)')], catalog, { mode: 'overwrite' }, { apply: false });
    expect(r.applied.map((a) => a.businessKey)).toEqual(['business.county']);
  });

  it('drops proposals below min confidence', async () => {
    const company: BusinessRecord = { id: 'c', properties: {} };
    const r = await applyProposals('c', company, [proposal('business.county', 'Jackson County (MI)', 0.4)], catalog, { mode: 'fill-empty', minConfidence: 0.7 }, { apply: false });
    expect(r.applied).toHaveLength(0);
    expect(r.skipped[0].reason).toContain('below min confidence');
  });

  it('skips create-only (multi-select) and unknown fields', async () => {
    const company: BusinessRecord = { id: 'c', properties: {} };
    const r = await applyProposals('c', company, [
      proposal('business.i_am_selling', ['product']),
      proposal('business.ghost', 'x'),
    ], catalog, { mode: 'fill-empty' }, { apply: false });
    expect(r.applied).toHaveLength(0);
    const reasons = r.skipped.map((s) => s.reason).join(' | ');
    expect(reasons).toContain('create-only');
    expect(reasons).toContain('catalog');
  });

  it('carries provenance on applied fields', async () => {
    const company: BusinessRecord = { id: 'c', properties: {} };
    const r = await applyProposals('c', company, [proposal('business.county', 'Jackson County (MI)')], catalog, { mode: 'fill-empty' }, { apply: false });
    expect(r.applied[0].provenance.source).toBe('t');
    expect(r.applied[0].provenance.confidence).toBe(0.9);
  });
});
