// pages/api/mapping/[slug]/save.ts — replace one sync's mappings (admin-guarded).
//
// POST { mappings: FieldMapping[] } with header `x-admin-secret: <ADMIN_SECRET>`.
// Validates + sanitizes each row, replaces the sync's rows atomically, bumps version, and
// invalidates the store cache so the change is live for the webhook immediately (no redeploy).

import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbStore } from '@/lib/mapping/store';
import { hasDatabase } from '@/lib/db';
import { isAdmin } from '@/lib/auth/admin';
import type { FieldMapping, SyncDirection } from '@/lib/mapping/types';

const DIRECTIONS: SyncDirection[] = ['up', 'down', 'both'];

function sanitize(raw: any): { ok: true; mappings: FieldMapping[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'mappings must be an array' };
  const out: FieldMapping[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] ?? {};
    const contactKey = typeof r.contactKey === 'string' ? r.contactKey.trim() : '';
    const businessKey = typeof r.businessKey === 'string' ? r.businessKey.trim() : '';
    if (!contactKey || !businessKey) return { ok: false, error: `row ${i}: contactKey and businessKey are required` };
    if (!DIRECTIONS.includes(r.direction)) return { ok: false, error: `row ${i}: direction must be up|down|both` };
    const m: FieldMapping = { contactKey, businessKey, direction: r.direction, mirrorDown: r.mirrorDown === true };
    if (typeof r.enabled === 'boolean') m.enabled = r.enabled;
    if (typeof r.note === 'string' && r.note.trim()) m.note = r.note.trim();
    if (Array.isArray(r.holdValues)) {
      const hv = r.holdValues.filter((v: any) => typeof v === 'string' && v.length);
      if (hv.length) m.holdValues = hv;
    }
    if (r.transform === 'countryCode') m.transform = 'countryCode';
    out.push(m);
  }
  return { ok: true, mappings: out };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!hasDatabase) return res.status(503).json({ error: 'Database not configured (POSTGRES_URL missing)' });
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });

  const slug = String(req.query.slug);
  const parsed = sanitize(req.body?.mappings);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  try {
    const set = await getDbStore().saveSync(slug, parsed.mappings);
    res.status(200).json({ ok: true, slug, version: set.version, updatedAt: set.updatedAt, count: set.mappings.length });
  } catch (error: any) {
    console.error('mapping/[slug]/save error:', error);
    res.status(500).json({ error: error?.message ?? 'Failed to save mappings' });
  }
}
