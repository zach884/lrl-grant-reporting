// The company engine (runEnrichers) now honors each enricher's gate config: an enricher whose gate
// fails for a given company is skipped. Default config = no gate = always runs (proven elsewhere).
// Here we mock resolveEnricherConfig so the real gate logic (evaluateGate) decides.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../configStore', () => ({
  resolveEnricherConfig: vi.fn(async (name: string) => {
    if (name === 'gated') {
      return { enricher: 'gated', sourceObject: 'business', enabled: true, combine: 'AND', groups: [{ combine: 'AND', filters: [{ field: 'business.status', anyOf: ['Active'] }] }] };
    }
    return { enricher: name, sourceObject: 'business', enabled: true, combine: 'AND', groups: [] };
  }),
}));

import { runEnrichers } from '../engine';
import type { Enricher, EnrichmentProposal } from '../types';
import type { BusinessRecord, CustomFieldCatalog } from '../../ghl/types';

const catalog: CustomFieldCatalog = { fields: [], folders: [], byKey: {}, byId: {} };

function enr(name: string, key: string): Enricher {
  return { name, produces: [key], async enrich() {
    return [{ businessKey: key, value: 'v', provenance: { source: name, method: 'computed', confidence: 1, timestamp: '2026-07-23T00:00:00Z' } }] as EnrichmentProposal[];
  } };
}

describe('runEnrichers — per-enricher gate', () => {
  it('skips a gated enricher when the company field is out of runOn, still runs ungated ones', async () => {
    const company: BusinessRecord = { id: 'c', properties: { status: 'Prospect' } };
    const props = await runEnrichers(company, catalog, [enr('gated', 'business.naics_code'), enr('open', 'business.county')]);
    const keys = props.map((p) => p.businessKey);
    expect(keys).toContain('business.county'); // ungated → ran
    expect(keys).not.toContain('business.naics_code'); // gated out (status Prospect ∉ {Active})
  });

  it('runs the gated enricher when the company matches the gate', async () => {
    const company: BusinessRecord = { id: 'c', properties: { status: 'Active' } };
    const props = await runEnrichers(company, catalog, [enr('gated', 'business.naics_code')]);
    expect(props.map((p) => p.businessKey)).toContain('business.naics_code');
  });
});
