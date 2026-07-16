// pages/api/wix/collection.ts — one Wix collection's column schema (?id=<collectionId>),
// used to populate the mapper's target-column dropdowns and drive wixResolve validation.

import type { NextApiRequest, NextApiResponse } from 'next';
import { hasWix } from '@/lib/wix/config';
import { getWixCollectionSchema } from '@/lib/wix/catalogCache';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!hasWix) return res.status(503).json({ error: 'Wix is not configured (set WIX_SITE_ID + OAuth creds).' });
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'id (collectionId) is required' });
  try {
    const force = req.query.refresh === 'true';
    const schema = await getWixCollectionSchema(id, force);
    res.status(200).json(schema);
  } catch (error: any) {
    console.error('wix/collection error:', error);
    res.status(500).json({ error: error?.message ?? 'Failed to load Wix collection schema' });
  }
}
