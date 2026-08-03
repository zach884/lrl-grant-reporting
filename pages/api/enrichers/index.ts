// pages/api/enrichers/index.ts — the enricher registry + each one's resolved gate config.
//
// Registry-driven (not a hardcoded list): reads the real defaultEnrichers (company) +
// defaultContactEnrichers (contact) so /enrichment always reflects what actually runs. Each entry
// carries its resolved config (stored row or code default) so the UI shows the live gate.

import type { NextApiRequest, NextApiResponse } from 'next';
import { defaultEnrichers, defaultContactEnrichers, defaultRecordEnrichers } from '@/lib/enrichment';
import { resolveEnricherConfig } from '@/lib/enrichment/configStore';
import { STAGE_SCORER_META } from '@/lib/stage/trigger';

export interface EnricherListItem {
  name: string;
  description?: string;
  produces: string[];
  target: 'company' | 'contact' | 'resource';
  sourceObject: string;
  /** True when this enricher's gate is read by the engine today (contact pipeline/CLI). */
  gateWired: boolean;
  config: Awaited<ReturnType<typeof resolveEnricherConfig>>;
}

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const items: EnricherListItem[] = [];
    for (const e of defaultEnrichers) {
      items.push({
        name: e.name, description: e.description, produces: e.produces,
        target: 'company', sourceObject: 'business', gateWired: true,
        config: await resolveEnricherConfig(e.name, 'business'),
      });
    }
    for (const e of defaultContactEnrichers) {
      items.push({
        name: e.name, description: e.description, produces: e.produces,
        target: 'contact', sourceObject: 'contact', gateWired: true,
        config: await resolveEnricherConfig(e.name, 'contact'),
      });
    }
    for (const { enricher: e, sourceObject } of defaultRecordEnrichers) {
      items.push({
        name: e.name, description: e.description, produces: e.produces,
        target: 'resource', sourceObject, gateWired: true,
        config: await resolveEnricherConfig(e.name, sourceObject),
      });
    }
    // The Client Stage scorer isn't an Enricher object (it appends a record rather than filling company
    // fields), so it's registered from its meta rather than defaultEnrichers.
    items.push({
      name: STAGE_SCORER_META.name, description: STAGE_SCORER_META.description, produces: STAGE_SCORER_META.produces,
      target: 'company', sourceObject: STAGE_SCORER_META.sourceObject, gateWired: true,
      config: await resolveEnricherConfig(STAGE_SCORER_META.name, STAGE_SCORER_META.sourceObject),
    });
    res.status(200).json({ enrichers: items });
  } catch (error: any) {
    console.error('enrichers/index error:', error);
    res.status(500).json({ error: error?.message ?? 'failed to list enrichers' });
  }
}
