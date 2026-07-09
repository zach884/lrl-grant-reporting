// pages/api/mapping/[slug].ts — GET one sync's mappings, annotated against live catalogs.
//
// Returns each row as a ResolvedFieldMapping (data types, existence, writability) plus a
// set-level issues list (missing fields, unwritable targets, duplicate destinations) so the
// editor can render per-row warnings without re-deriving them client-side.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbStore } from '@/lib/mapping/store';
import { hasDatabase } from '@/lib/db';
import { getCatalogs } from '@/lib/ghl/catalogCache';
import { resolveMappings, collectIssues } from '@/lib/mapping/resolve';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!hasDatabase) return res.status(503).json({ error: 'Database not configured (POSTGRES_URL missing)' });
  const slug = String(req.query.slug);
  try {
    const set = await getDbStore().loadSync(slug);
    const { contact, business } = await getCatalogs();
    const resolved = resolveMappings(set.mappings, contact, business);
    const issues = collectIssues(resolved);
    res.status(200).json({
      slug,
      version: set.version,
      updatedAt: set.updatedAt,
      mappings: resolved,
      issues,
    });
  } catch (error: any) {
    console.error('mapping/[slug] error:', error);
    res.status(500).json({ error: error?.message ?? 'Failed to load sync' });
  }
}
