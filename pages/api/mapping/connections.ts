// pages/api/mapping/connections.ts — unified list of all mapping connections for the hub.
//
// Merges the GHL↔GHL contact-company sync + every GHL→Wix set into one shape the /mappings
// card grid renders. Lightweight (counts only); the detail view does the full resolve.

import type { NextApiRequest, NextApiResponse } from 'next';
import { hasDatabase } from '@/lib/db';
import { getDbStore } from '@/lib/mapping/store';
import { DEFAULT_SYNC_SLUG } from '@/lib/mapping/dbStore';
import { getWixStore } from '@/lib/mapping/wixStore';

export interface ConnectionCard {
  id: string;
  name: string;
  source: { tool: string; object: string };
  target: { tool: string; object: string };
  oneWay: boolean;
  fieldCount: number;
  activeCount: number;
  enabled: boolean;
  updatedAt: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!hasDatabase) return res.status(503).json({ error: 'database not configured' });
  try {
    const connections: ConnectionCard[] = [];

    // GHL <-> GHL (the existing contact-company sync).
    try {
      const ghl = await getDbStore().loadSync(DEFAULT_SYNC_SLUG);
      connections.push({
        id: DEFAULT_SYNC_SLUG,
        name: 'Contact ⇄ Company',
        source: { tool: 'ghl', object: 'contact' },
        target: { tool: 'ghl', object: 'business' },
        oneWay: false,
        fieldCount: ghl.mappings.length,
        activeCount: ghl.mappings.filter((m) => m.enabled !== false).length,
        enabled: true,
        updatedAt: ghl.updatedAt,
      });
    } catch { /* no GHL sync row yet */ }

    // GHL -> Wix (each set).
    try {
      const sets = await getWixStore().listSets();
      for (const s of sets) {
        connections.push({
          id: s.id,
          name: s.name,
          source: { tool: 'ghl', object: s.sourceObject },
          target: { tool: 'wix', object: s.wixCollectionId },
          oneWay: true,
          fieldCount: s.rowCount,
          activeCount: s.rowCount,
          enabled: s.enabled,
          updatedAt: s.updatedAt,
        });
      }
    } catch { /* Wix store unavailable */ }

    res.status(200).json({ connections });
  } catch (error: any) {
    console.error('mapping/connections error:', error);
    res.status(500).json({ error: error?.message ?? 'failed to list connections' });
  }
}
