// pages/api/wix/collections.ts — list the site's Wix CMS collections for the mapper's
// target dropdown. Read-only; guards on Wix credentials being configured.

import type { NextApiRequest, NextApiResponse } from 'next';
import { hasWix } from '@/lib/wix/config';
import { getWixCollections } from '@/lib/wix/catalogCache';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!hasWix) return res.status(503).json({ error: 'Wix is not configured (set WIX_SITE_ID + OAuth creds).' });
  try {
    const force = req.query.refresh === 'true';
    const collections = await getWixCollections(force);
    res.status(200).json({ collections });
  } catch (error: any) {
    console.error('wix/collections error:', error);
    res.status(500).json({ error: error?.message ?? 'Failed to load Wix collections' });
  }
}
