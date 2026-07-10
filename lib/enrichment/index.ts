// lib/enrichment/index.ts — public surface of the enrichment engine.

export * from './types';
export * from './engine';
export { countyEnricher, countyRawToLabel } from './enrichers/county';
export { geoZoneEnricher } from './enrichers/geoZone';
export { laraIdEnricher } from './enrichers/laraId';
export { naicsEnricher, deriveNaicsText } from './enrichers/naics';

import { countyEnricher } from './enrichers/county';
import { geoZoneEnricher } from './enrichers/geoZone';
import { laraIdEnricher } from './enrichers/laraId';
import { naicsEnricher } from './enrichers/naics';
import { Enricher } from './types';

/** Default registry. NAICS is AI-classified; LARA is a no-op until its source is wired. */
export const defaultEnrichers: Enricher[] = [countyEnricher, geoZoneEnricher, naicsEnricher, laraIdEnricher];
