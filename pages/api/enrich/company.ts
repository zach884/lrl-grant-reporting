// pages/api/enrich/company.ts — enrich one company (dry-run preview or apply).
//
// POST { companyId, apply? }. Dry-run by default (shows proposals + what would be written,
// no writes). apply=true requires the admin secret (x-admin-secret) and writes to GHL.
// Powers the /mappings-style spot-check on the Data Enrichment page.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getCatalogs } from '@/lib/ghl/catalogCache';
import { enrichCompany, defaultEnrichers } from '@/lib/enrichment';
import { isAdmin } from '@/lib/auth/admin';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const companyId = (req.body?.companyId || req.query.companyId) as string | undefined;
  if (!companyId) return res.status(400).json({ error: 'companyId required' });

  const wantApply = req.body?.apply === true || req.query.apply === '1';
  if (wantApply && !isAdmin(req)) return res.status(401).json({ error: 'unauthorized (admin secret required to apply)' });

  try {
    const { business } = await getCatalogs();
    const r = await enrichCompany(
      companyId,
      defaultEnrichers,
      business,
      // Preview shows every proposal (minConfidence 0); a real apply gates on confidence.
      { mode: 'overwrite', minConfidence: wantApply ? 0.7 : 0 },
      { apply: wantApply },
    );
    res.status(200).json({
      ok: true,
      companyId,
      applied: r.applied,
      proposals: r.proposals,
      skipped: r.skipped,
      didWrite: r.didWrite,
    });
  } catch (e: any) {
    console.error('enrich/company error:', e);
    res.status(500).json({ error: e?.message ?? 'enrichment failed' });
  }
}
