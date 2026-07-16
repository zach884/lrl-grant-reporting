// pages/api/wix/sets/[id].ts — get (GET) / save (PUT) / delete (DELETE) one mapping set.
// Mutations are admin-guarded.

import type { NextApiRequest, NextApiResponse } from 'next';
import { hasDatabase } from '@/lib/db';
import { isAdmin } from '@/lib/auth/admin';
import { getWixStore } from '@/lib/mapping/wixStore';
import { sanitizeWixSet } from '@/lib/mapping/wixSanitize';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!hasDatabase) return res.status(503).json({ error: 'database not configured' });
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'id required' });
  const store = getWixStore();

  if (req.method === 'GET') {
    const set = await store.getSet(id);
    return set ? res.status(200).json({ set }) : res.status(404).json({ error: 'not found' });
  }

  if (req.method === 'PUT') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
    try {
      const input = sanitizeWixSet(req.body, process.env.WIX_SITE_ID ?? '');
      const set = await store.saveSet(id, input);
      return res.status(200).json({ set });
    } catch (e: any) {
      return res.status(400).json({ error: e?.message ?? 'invalid set' });
    }
  }

  if (req.method === 'DELETE') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
    await store.deleteSet(id);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'GET, PUT, or DELETE' });
}
