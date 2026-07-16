// pages/api/wix/sets.ts — list (GET) + create (POST) GHL->Wix mapping sets.
// Writes are admin-guarded (x-admin-secret). Reads rely on Vercel Deployment Protection.

import type { NextApiRequest, NextApiResponse } from 'next';
import { hasDatabase } from '@/lib/db';
import { isAdmin } from '@/lib/auth/admin';
import { getWixStore } from '@/lib/mapping/wixStore';
import { sanitizeWixSet } from '@/lib/mapping/wixSanitize';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!hasDatabase) return res.status(503).json({ error: 'database not configured' });
  const store = getWixStore();

  if (req.method === 'GET') {
    try {
      return res.status(200).json({ sets: await store.listSets() });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? 'failed to list sets' });
    }
  }

  if (req.method === 'POST') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
    try {
      const input = sanitizeWixSet(req.body, process.env.WIX_SITE_ID ?? '');
      const set = await store.createSet(input);
      return res.status(200).json({ set });
    } catch (e: any) {
      return res.status(400).json({ error: e?.message ?? 'invalid set' });
    }
  }

  return res.status(405).json({ error: 'GET or POST' });
}
