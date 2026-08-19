// pages/api/companies/search.ts — company type-ahead for the activity logger.
//
// The /businesses/ endpoint has no server-side name query, so we enumerate once (895 companies at
// 100/page) and cache the roster in-process for 10 minutes — the same TTL as the field catalogs.
// Matching is normalized (case/punctuation/suffix-insensitive, via the dedup normalizer) so
// "acme" finds "Acme Corp, LLC"; a prefix match ranks above a substring match.

import type { NextApiRequest, NextApiResponse } from 'next';
import { listAllBusinesses } from '@/lib/ghl/businesses';
import { normalizeName } from '@/lib/dedup/normalize';

const TTL_MS = 10 * 60 * 1000;
let cache: { at: number; rows: Array<{ id: string; name: string; norm: string }> } | null = null;

async function roster() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const all = await listAllBusinesses();
  const rows = all
    .filter((b) => b.id && b.name)
    .map((b) => ({ id: b.id, name: b.name, norm: normalizeName(b.name) }));
  cache = { at: Date.now(), rows };
  return rows;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const q = String(req.query.q ?? '').trim();
  const limit = Math.min(Number(req.query.limit ?? 12) || 12, 50);
  if (q.length < 2) return res.status(200).json({ companies: [] });

  try {
    const rows = await roster();
    const needle = normalizeName(q);
    const companies = rows
      .map((r) => ({ r, at: r.norm.indexOf(needle) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at || a.r.name.localeCompare(b.r.name))
      .slice(0, limit)
      .map((x) => ({ id: x.r.id, name: x.r.name }));
    res.status(200).json({ companies, total: rows.length });
  } catch (error: any) {
    console.error('Company search error:', error);
    res.status(500).json({ error: error.message ?? 'Company search failed' });
  }
}
