// pages/api/mapping/dry-run.ts — read-only "what would this GHL↔GHL connection write?"
// POST { slug, sourceRecordId }. Traverses the connection's association from the source record
// to its counterparts and returns the planned writes. NO writes. Admin-guarded (hits GHL reads).

import type { NextApiRequest, NextApiResponse } from 'next';
import { hasDatabase } from '@/lib/db';
import { isAdmin } from '@/lib/auth/admin';
import { getDbStore } from '@/lib/mapping/store';
import { planConnectionDryRun, type DryRunConnection } from '@/lib/sync/dryrun';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!hasDatabase) return res.status(503).json({ error: 'database not configured' });

  const slug = String(req.body?.slug ?? '');
  const sourceRecordId = String(req.body?.sourceRecordId ?? '');
  if (!slug || !sourceRecordId) return res.status(400).json({ error: 'slug and sourceRecordId are required' });

  try {
    const store = getDbStore();
    const meta = await store.getSyncMeta(slug);
    if (!meta) return res.status(404).json({ error: 'connection not found' });
    if (!meta.associationId) {
      return res.status(400).json({ error: 'This connection has no association (contact↔company uses the built-in live sync).' });
    }
    const set = await store.loadSync(slug);
    const connection: DryRunConnection = {
      sourceObject: meta.sourceObject,
      targetObject: meta.destObject,
      associationId: meta.associationId,
      rows: set.mappings.map((m) => ({ sourceKey: m.contactKey, targetKey: m.businessKey, direction: m.direction, transform: m.transform, enabled: m.enabled, holdValues: m.holdValues })),
    };
    const result = await planConnectionDryRun(connection, sourceRecordId);
    return res.status(200).json({ result });
  } catch (e: any) {
    console.error('mapping/dry-run error:', e);
    return res.status(500).json({ error: e?.message ?? 'dry-run failed' });
  }
}
