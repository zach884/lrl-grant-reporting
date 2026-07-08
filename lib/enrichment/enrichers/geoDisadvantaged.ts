// lib/enrichment/enrichers/geoDisadvantaged.ts — HUBZone / Opportunity Zone flag.
//
// Uses the geocode's point-in-polygon check against SBA HUBZone + Opportunity Zone
// layers (see lib/enrich.ts queryArcGIS). Produces business.geo_disadvantaged.
// Target field may be SINGLE_OPTIONS (Yes/No) or TEXT — coercion resolves on write;
// if the field doesn't exist on the company object, the engine skips it cleanly.

import { Enricher, EnricherInput, EnrichmentProposal } from '../types';

export const geoDisadvantagedEnricher: Enricher = {
  name: 'geo-disadvantaged',
  description: 'Flags whether the company address falls in a HUBZone or Opportunity Zone.',
  produces: ['business.geo_disadvantaged'],
  async enrich(input: EnricherInput): Promise<EnrichmentProposal[]> {
    const { geoDisadvantaged } = await input.geocode();
    if (geoDisadvantaged == null) return []; // unknown (geocode failed) -> propose nothing
    return [
      {
        businessKey: 'business.geo_disadvantaged',
        value: geoDisadvantaged ? 'Yes' : 'No',
        provenance: {
          source: 'arcgis-hubzone-oz',
          method: 'api',
          confidence: 0.85,
          timestamp: new Date().toISOString(),
          rationale: `Point-in-polygon against SBA HUBZone + Opportunity Zone layers`,
        },
      },
    ];
  },
};
