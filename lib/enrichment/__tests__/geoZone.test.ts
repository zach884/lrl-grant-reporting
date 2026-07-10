import { describe, it, expect } from 'vitest';
import { geoZoneEnricher } from '../enrichers/geoZone';
import type { EnricherInput, GeocodeResult } from '../types';
import type { BusinessRecord, CustomFieldCatalog } from '../../ghl/types';

function input(geo: GeocodeResult): EnricherInput {
  const catalog: CustomFieldCatalog = { fields: [], folders: [], byKey: {}, byId: {} };
  return {
    company: { id: 'co1', properties: {} } as BusinessRecord,
    businessCatalog: catalog,
    address: {},
    geocode: async () => geo,
  };
}

async function value(geo: GeocodeResult): Promise<string | undefined> {
  const out = await geoZoneEnricher.enrich(input(geo));
  return out[0]?.value as string | undefined;
}

describe('geoZoneEnricher', () => {
  it('emits the combined value when in both zones', async () => {
    expect(await value({ county: null, hubzone: true, opportunityZone: true })).toBe('HUBZone + Opportunity Zone');
  });
  it('emits HUBZone when only in a HUBZone', async () => {
    expect(await value({ county: null, hubzone: true, opportunityZone: false })).toBe('HUBZone');
  });
  it('emits Opportunity Zone when only in an OZ', async () => {
    expect(await value({ county: null, hubzone: false, opportunityZone: true })).toBe('Opportunity Zone');
  });
  it('emits None when confirmed in neither zone', async () => {
    expect(await value({ county: null, hubzone: false, opportunityZone: false })).toBe('None');
  });
  it('skips when geocode failed (both unknown)', async () => {
    const out = await geoZoneEnricher.enrich(input({ county: null, hubzone: null, opportunityZone: null }));
    expect(out).toEqual([]);
  });
  it('skips on partial-unknown (no positive, one layer unknown)', async () => {
    const out = await geoZoneEnricher.enrich(input({ county: null, hubzone: false, opportunityZone: null }));
    expect(out).toEqual([]);
  });
});
