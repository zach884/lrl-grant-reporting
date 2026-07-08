// lib/enrichment/enrichers/laraId.ts — Michigan LARA entity id lookup (SCAFFOLD).
//
// STATUS: interface-complete, data source NOT yet wired. LARA ID is the dedup key, so
// this enricher is high-value but needs a decision on the source:
//   - Michigan LARA COFS "Business Entity Search" (cofs.lara.state.mi.us) has no clean
//     public JSON API; options are a licensed dataset or a sanctioned scrape.
//   - Match must be by legal name + address, and LARA-ID assignment should REQUIRE human
//     confirmation before write (it's the dedup key — a wrong match merges companies).
// Until wired, enrich() returns no proposals (so it's safe to include in the registry).

import { Enricher, EnricherInput, EnrichmentProposal } from '../types';

export const laraIdEnricher: Enricher = {
  name: 'lara-id',
  description: 'Looks up the Michigan LARA entity id by legal name + address (NOT YET WIRED).',
  produces: ['business.lara_id'],
  async enrich(_input: EnricherInput): Promise<EnrichmentProposal[]> {
    // TODO: wire the LARA COFS source; return a proposal with LOW confidence + rationale
    // (candidate entity name/id) so the apply policy / a human can confirm before writing.
    return [];
  },
};
