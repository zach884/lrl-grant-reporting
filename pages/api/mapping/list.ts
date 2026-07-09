// pages/api/mapping/list.ts — list the configured syncs (v1: one).
import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbStore } from '@/lib/mapping/store';
import { hasDatabase } from '@/lib/db';

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  if (!hasDatabase) return res.status(503).json({ error: 'Database not configured (POSTGRES_URL missing)' });
  try {
    const syncs = await getDbStore().listSyncs();
    res.status(200).json({ syncs });
  } catch (error: any) {
    console.error('mapping/list error:', error);
    res.status(500).json({ error: error?.message ?? 'Failed to list syncs' });
  }
}
