// pages/api/mapping/[slug]/suggest.ts — auto-suggest field pairings from the live catalogs.
//
// GET returns draft FieldMapping[] (from lib/mapping/suggest). The editor merges these with
// the existing rows; the human curates before saving. Read-only, so no admin guard (it sits
// behind Vercel Deployment Protection like the rest of the app).

import type { NextApiRequest, NextApiResponse } from 'next';
import { getCatalogs } from '@/lib/ghl/catalogCache';
import { suggestMappings } from '@/lib/mapping/suggest';

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const { contact, business } = await getCatalogs();
    const suggestions = suggestMappings(contact, business);
    res.status(200).json({ suggestions });
  } catch (error: any) {
    console.error('mapping/[slug]/suggest error:', error);
    res.status(500).json({ error: error?.message ?? 'Failed to suggest mappings' });
  }
}
