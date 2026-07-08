// lib/enrichment/index.ts — public surface of the enrichment engine.

export * from './types';
export * from './engine';
export { countyEnricher, countyRawToLabel } from './enrichers/county';
export { geoDisadvantagedEnricher } from './enrichers/geoDisadvantaged';
export { laraIdEnricher } from './enrichers/laraId';

import { countyEnricher } from './enrichers/county';
import { geoDisadvantagedEnricher } from './enrichers/geoDisadvantaged';
import { laraIdEnricher } from './enrichers/laraId';
import { Enricher } from './types';

/** Default registry. LARA is included but currently a no-op until its source is wired. */
export const defaultEnrichers: Enricher[] = [countyEnricher, geoDisadvantagedEnricher, laraIdEnricher];
