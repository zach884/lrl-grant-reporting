// pages/api/mapping/connections.ts — unified list of all mapping connections for the hub,
// plus create (POST) for a new GHL↔GHL connection.
//
// GET merges every GHL↔GHL sync (the syncs table) + every GHL→Wix set into one card shape.
// POST creates a new GHL↔GHL connection (a syncs row with its object pair + associationId).

import type { NextApiRequest, NextApiResponse } from 'next';
import { hasDatabase } from '@/lib/db';
import { isAdmin } from '@/lib/auth/admin';
import { getDbStore } from '@/lib/mapping/store';
import { getWixStore } from '@/lib/mapping/wixStore';

export interface ConnectionCard {
  id: string;
  name: string;
  source: { tool: string; object: string };
  target: { tool: string; object: string };
  oneWay: boolean;
  associationId?: string | null;
  fieldCount: number;
  activeCount: number;
  enabled: boolean;
  updatedAt: string;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'sync';
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!hasDatabase) return res.status(503).json({ error: 'database not configured' });
  const store = getDbStore();

  if (req.method === 'POST') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
    const { name, sourceObject, destObject, associationId } = req.body ?? {};
    if (!name || !sourceObject || !destObject) return res.status(400).json({ error: 'name, sourceObject, destObject required' });
    try {
      // Unique slug: base from name, add a short suffix on collision.
      const existing = new Set((await store.listSyncs()).map((s) => s.slug));
      let slug = slugify(String(name));
      if (existing.has(slug)) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
      const meta = await store.createSync({ slug, name: String(name), sourceObject: String(sourceObject), destObject: String(destObject), associationId: associationId ?? null });
      return res.status(200).json({ connection: meta });
    } catch (e: any) {
      return res.status(400).json({ error: e?.message ?? 'failed to create connection' });
    }
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'GET or POST' });

  try {
    const connections: ConnectionCard[] = [];

    // GHL↔GHL syncs (all rows in the syncs table).
    try {
      for (const s of await store.listSyncs()) {
        connections.push({
          id: s.slug,
          name: s.name,
          source: { tool: 'ghl', object: s.sourceObject },
          target: { tool: 'ghl', object: s.destObject },
          oneWay: false,
          associationId: s.associationId,
          fieldCount: s.count,
          activeCount: s.count,
          enabled: true,
          updatedAt: s.updatedAt,
        });
      }
    } catch { /* no syncs yet */ }

    // GHL→Wix sets.
    try {
      for (const s of await getWixStore().listSets()) {
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
