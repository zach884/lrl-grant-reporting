// lib/enrichment/index.ts — public surface of the enrichment engine.

export * from './types';
export * from './configTypes';
export * from './gate';
export * from './engine';
export * from './contactEngine';
export * from './configStore';
export * from './data/readiness';
export { countyEnricher, countyRawToLabel } from './enrichers/county';
export { geoZoneEnricher } from './enrichers/geoZone';
export { laraIdEnricher } from './enrichers/laraId';
export { naicsEnricher, deriveNaicsText } from './enrichers/naics';
export { readinessTagger, rederiveProposals, deriveProfileText, passesMembershipGate } from './enrichers/readinessTagger';

import { countyEnricher } from './enrichers/county';
import { geoZoneEnricher } from './enrichers/geoZone';
import { laraIdEnricher } from './enrichers/laraId';
import { naicsEnricher } from './enrichers/naics';
import { readinessTagger } from './enrichers/readinessTagger';
import { Enricher, ContactEnricher } from './types';

/** Default company enricher registry. NAICS is AI-classified; LARA is a no-op until its source is wired. */
export const defaultEnrichers: Enricher[] = [countyEnricher, geoZoneEnricher, naicsEnricher, laraIdEnricher];

/** Default CONTACT enricher registry (currently the readiness-tagger). */
export const defaultContactEnrichers: ContactEnricher[] = [readinessTagger];
