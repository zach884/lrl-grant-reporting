// lib/enrichment/enrichers/county.ts — ZIP/address -> LRL county option label.
//
// The company `county` field is SINGLE_OPTIONS with 83 MI counties as "<County> County (MI)"
// plus "Other" (non-MI). We geocode the address, then map the raw county name to that label.

import { Enricher, EnricherInput, EnrichmentProposal } from '../types';
import { GhlFieldOption } from '../../ghl/types';

/** Map a raw geocoder county name (+ state) to the LRL option label. */
export function countyRawToLabel(
  raw: string | null | undefined,
  state: string | undefined,
  options?: GhlFieldOption[],
): string | null {
  if (!raw) return null;
  const otherLabel = options?.find((o) => o.label.toLowerCase() === 'other')?.label ?? 'Other';
  if (state && state.trim().toUpperCase() !== 'MI') return otherLabel;

  const base = raw.replace(/\s+county$/i, '').trim();
  const candidate = `${base} County (MI)`;
  if (options && options.length) {
    const hit = options.find((o) => o.label.toLowerCase() === candidate.toLowerCase());
    return hit ? hit.label : otherLabel;
  }
  // No option list available (reads are flaky) — construct optimistically for MI.
  return candidate;
}

export const countyEnricher: Enricher = {
  name: 'county',
  description: 'Derives the company county from its postal address (Census + Nominatim + FCC).',
  produces: ['business.county'],
  async enrich(input: EnricherInput): Promise<EnrichmentProposal[]> {
    const { county } = await input.geocode();
    const def = input.businessCatalog.byKey['business.county'];
    const label = countyRawToLabel(county, input.address.state, def?.options);
    if (!label) return [];
    const isOther = label.toLowerCase() === 'other';
    return [
      {
        businessKey: 'business.county',
        value: label,
        provenance: {
          source: 'census-geocoder',
          method: 'api',
          confidence: isOther ? 0.6 : 0.92,
          timestamp: new Date().toISOString(),
          rationale: `Geocoded "${[input.address.address1, input.address.city, input.address.state, input.address.postalCode].filter(Boolean).join(', ')}" -> county "${county}"`,
        },
      },
    ];
  },
};
