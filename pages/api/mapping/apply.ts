// pages/api/mapping/apply.ts — LIVE apply of a GHL↔GHL connection from ONE source record.
// POST { slug, sourceRecordId, apply? } (apply defaults true; pass false to preview two-way).
// Admin-guarded — this writes to live GHL records.

import type { NextApiRequest, NextApiResponse } from 'next';
import { hasDatabase } from '@/lib/db';
import { isAdmin } from '@/lib/auth/admin';
import { getDbStore } from '@/lib/mapping/store';
import { syncConnection } from '@/lib/sync/apply';
import type { DryRunConnection } from '@/lib/sync/dryrun';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!hasDatabase) return res.status(503).json({ error: 'database not configured' });

  const slug = String(req.body?.slug ?? '');
  const sourceRecordId = String(req.body?.sourceRecordId ?? '');
  const apply = req.body?.apply !== false; // default true
  if (!slug || !sourceRecordId) return res.status(400).json({ error: 'slug and sourceRecordId are required' });

  try {
    const store = getDbStore();
    const meta = await store.getSyncMeta(slug);
    if (!meta) return res.status(404).json({ error: 'connection not found' });
    if (!meta.associationId) return res.status(400).json({ error: 'This connection has no association/scalar link (contact↔company uses the built-in live sync).' });
    const set = await store.loadSync(slug);
    const connection: DryRunConnection = {
      sourceObject: meta.sourceObject,
      targetObject: meta.destObject,
      associationId: meta.associationId,
      rows: set.mappings.map((m) => ({ sourceKey: m.contactKey, targetKey: m.businessKey, direction: m.direction, transform: m.transform, enabled: m.enabled })),
    };
    const result = await syncConnection(connection, sourceRecordId, { apply });
    return res.status(200).json({ result });
  } catch (e: any) {
    console.error('mapping/apply error:', e);
    return res.status(500).json({ error: e?.message ?? 'apply failed' });
  }
}
