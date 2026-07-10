// lib/enrichment/enrichers/geoZone.ts — HUBZone / Opportunity Zone classification.
//
// Uses the geocode's per-layer point-in-polygon checks (lib/enrich.ts queryArcGIS) and emits
// ONE single-select value for business.geo_zone: 'HUBZone', 'Opportunity Zone',
// 'HUBZone + Opportunity Zone', or 'N/A'. Single-select (not multi-select) because company
// MULTIPLE_OPTIONS fields aren't API-writable on update; the combined value covers overlap.
// The target field must exist with matching option labels or the engine skips the proposal.

import { Enricher, EnricherInput, EnrichmentProposal } from '../types';

export const geoZoneEnricher: Enricher = {
  name: 'geo-zone',
  description: 'Classifies whether the company address falls in a HUBZone and/or Opportunity Zone.',
  produces: ['business.geo_zone'],
  async enrich(input: EnricherInput): Promise<EnrichmentProposal[]> {
    const { hubzone, opportunityZone } = await input.geocode();
    if (hubzone == null && opportunityZone == null) return []; // geocode failed → unknown

    const inHub = hubzone === true;
    const inOz = opportunityZone === true;
    let value: string;
    if (inHub && inOz) value = 'HUBZone + Opportunity Zone';
    else if (inHub) value = 'HUBZone';
    else if (inOz) value = 'Opportunity Zone';
    else if (hubzone === false && opportunityZone === false) value = 'N/A';
    else return []; // one layer positive-free but the other unknown → not confident, skip

    return [
      {
        businessKey: 'business.geo_zone',
        value,
        provenance: {
          source: 'arcgis-hubzone-oz',
          method: 'api',
          confidence: 0.85,
          timestamp: new Date().toISOString(),
          rationale: `Point-in-polygon: HUBZone=${inHub}, OpportunityZone=${inOz}`,
        },
      },
    ];
  },
};
