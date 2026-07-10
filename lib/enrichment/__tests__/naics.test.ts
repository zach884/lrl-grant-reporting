import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the AI client so no network call happens; classifyJson is controllable per test.
vi.mock('../../ai/anthropic', () => ({
  hasAnthropic: true,
  classifyJson: vi.fn(),
}));

import { classifyJson } from '../../ai/anthropic';
import { naicsEnricher, deriveNaicsText } from '../enrichers/naics';
import type { EnricherInput } from '../types';
import type { BusinessRecord, CustomFieldCatalog } from '../../ghl/types';

const mockClassify = classifyJson as unknown as ReturnType<typeof vi.fn>;

function input(properties: Record<string, unknown>): EnricherInput {
  const catalog: CustomFieldCatalog = { fields: [], folders: [], byKey: {}, byId: {} };
  const company: BusinessRecord = { id: 'co1', properties } as BusinessRecord;
  return {
    company,
    businessCatalog: catalog,
    address: {},
    geocode: async () => ({ county: null, hubzone: null, opportunityZone: null }),
  };
}

beforeEach(() => mockClassify.mockReset());

describe('deriveNaicsText', () => {
  it('builds a labeled blob from descriptive fields', () => {
    const t = deriveNaicsText({ name: 'Acme', description: 'We build robots', empty: '' });
    expect(t).toContain('Company: Acme');
    expect(t).toContain('Description: We build robots');
    expect(t).not.toContain('empty');
  });
});

describe('naicsEnricher', () => {
  it('skips (no AI call) when a valid 6-digit code is already set', async () => {
    const out = await naicsEnricher.enrich(input({ naics_code: 541511, description: 'software' }));
    expect(out).toEqual([]);
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('skips when there is no descriptive text', async () => {
    const out = await naicsEnricher.enrich(input({ naics_code: '' }));
    expect(out).toEqual([]);
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('proposes a validated code from the description', async () => {
    mockClassify.mockResolvedValue({ naics_code: '541511', confidence: 0.9, rationale: 'custom software dev' });
    const out = await naicsEnricher.enrich(input({ description: 'We write custom software for clients' }));
    expect(out).toHaveLength(1);
    expect(out[0].businessKey).toBe('business.naics_code');
    expect(out[0].value).toBe(541511);
    expect(out[0].provenance.source).toBe('naics-ai-classifier');
    expect(out[0].provenance.confidence).toBe(0.9);
    expect(out[0].provenance.rationale).toContain('Custom Computer Programming Services');
  });

  it('re-classifies when the current code is invalid (wrong length / not real)', async () => {
    mockClassify.mockResolvedValue({ naics_code: '541511', confidence: 0.8, rationale: 'x' });
    const out = await naicsEnricher.enrich(input({ naics_code: '5415', description: 'software' }));
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe(541511);
  });

  it('drops a hallucinated code not in the official set', async () => {
    mockClassify.mockResolvedValue({ naics_code: '999999', confidence: 0.95, rationale: 'nope' });
    const out = await naicsEnricher.enrich(input({ description: 'mystery business' }));
    expect(out).toEqual([]);
  });
});
