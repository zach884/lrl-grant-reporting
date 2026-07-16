// pages/api/mapping/associations.ts — the location's GHL object-association graph.
// Powers the mapper's object pickers: a GHL↔GHL sync can only traverse a pair that shares an
// association, and the user picks WHICH association when several connect the same two objects.

import type { NextApiRequest, NextApiResponse } from 'next';
import { listAssociationDefs, type AssociationDef } from '@/lib/ghl/associations';

const TTL_MS = 10 * 60 * 1000;
let cache: { at: number; defs: AssociationDef[] } | null = null;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const force = req.query.refresh === 'true';
    if (force || !cache || Date.now() - cache.at > TTL_MS) {
      cache = { at: Date.now(), defs: await listAssociationDefs() };
    }
    res.status(200).json({ associations: cache.defs });
  } catch (error: any) {
    console.error('mapping/associations error:', error);
    res.status(500).json({ error: error?.message ?? 'failed to load associations' });
  }
}
