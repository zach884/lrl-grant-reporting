// pages/api/mapping/[slug].ts — GET one sync's mappings, annotated against live catalogs.
//
// Returns each row as a ResolvedFieldMapping (data types, existence, writability) plus a
// set-level issues list (missing fields, unwritable targets, duplicate destinations) so the
// editor can render per-row warnings without re-deriving them client-side.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbStore } from '@/lib/mapping/store';
import { hasDatabase } from '@/lib/db';
import { isAdmin } from '@/lib/auth/admin';
import { getCatalogs } from '@/lib/ghl/catalogCache';
import { resolveMappings, collectIssues } from '@/lib/mapping/resolve';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!hasDatabase) return res.status(503).json({ error: 'Database not configured (POSTGRES_URL missing)' });
  const slug = String(req.query.slug);

  // Delete a connection (admin-guarded). contact-company is protected — it's the live sync.
  if (req.method === 'DELETE') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
    if (slug === 'contact-company') return res.status(400).json({ error: 'the contact↔company sync cannot be deleted' });
    try {
      await getDbStore().deleteSync(slug);
      return res.status(200).json({ ok: true });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? 'delete failed' });
    }
  }

  try {
    const store = getDbStore();
    const [set, meta] = await Promise.all([store.loadSync(slug), store.getSyncMeta(slug)]);
    // The live-catalog resolver (contactExists/businessWritable/issues) is contact↔company
    // specific. For that pair, resolve as before; for other GHL↔GHL pairs, return raw rows
    // (the object-agnostic editor validates against the pair's own catalogs client-side).
    const isContactCompany = !meta || (meta.sourceObject === 'contact' && meta.destObject === 'business');
    let mappings: any[] = set.mappings;
    let issues: any[] = [];
    if (isContactCompany) {
      const { contact, business } = await getCatalogs();
      mappings = resolveMappings(set.mappings, contact, business);
      issues = collectIssues(mappings as any);
    }
    res.status(200).json({
      slug,
      version: set.version,
      updatedAt: set.updatedAt,
      meta,
      mappings,
      issues,
    });
  } catch (error: any) {
    console.error('mapping/[slug] error:', error);
    res.status(500).json({ error: error?.message ?? 'Failed to load sync' });
  }
}
