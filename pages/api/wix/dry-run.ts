// pages/api/wix/dry-run.ts — preview what a mapping set would write to Wix for one contact.
// POST { setId, contactId }. No writes (apply:false). Admin-guarded (hits GHL + Wix reads).

import type { NextApiRequest, NextApiResponse } from 'next';
import { hasDatabase } from '@/lib/db';
import { isAdmin } from '@/lib/auth/admin';
import { hasWix } from '@/lib/wix/config';
import { getCatalogs } from '@/lib/ghl/catalogCache';
import { getWixStore } from '@/lib/mapping/wixStore';
import { getWixCollectionSchema } from '@/lib/wix/catalogCache';
import { syncContactToWix } from '@/lib/wix-sync';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!hasDatabase) return res.status(503).json({ error: 'database not configured' });
  if (!hasWix) return res.status(503).json({ error: 'Wix not configured' });

  const setId = String(req.body?.setId ?? '');
  const contactId = String(req.body?.contactId ?? '');
  if (!setId || !contactId) return res.status(400).json({ error: 'setId and contactId are required' });

  try {
    const set = await getWixStore().getSet(setId);
    if (!set) return res.status(404).json({ error: 'mapping set not found' });
    const catalogs = await getCatalogs();
    const schema = await getWixCollectionSchema(set.wixCollectionId);
    const result = await syncContactToWix(contactId, set, catalogs.contact, schema, { apply: false });
    return res.status(200).json({ result });
  } catch (e: any) {
    console.error('wix/dry-run error:', e);
    return res.status(500).json({ error: e?.message ?? 'dry-run failed' });
  }
}
