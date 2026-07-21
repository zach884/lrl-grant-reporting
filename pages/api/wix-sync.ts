// pages/api/wix-sync.ts — standalone contact ENRICH + Wix Team sync webhook.
//
// Runs the shared contact→Team pipeline (lib/wix-sync/pipeline): enrich on contact.status=Approved,
// then sync every enabled contact Wix set (each set's status gate decides upsert/update/hide/skip).
// The SAME pipeline also runs inside /api/sync/up, so a single "Contact Changed" webhook can drive
// everything; this endpoint is kept for manual/isolated runs and back-compat.
//
// Auth: shared secret in `x-webhook-secret` header (or `?secret=`) vs WIX_SYNC_WEBHOOK_SECRET.
// Body: { "contactId": "{{contact.id}}" }. Add ?dryRun=1 to preview.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getCatalogs } from '@/lib/ghl/catalogCache';
import { hasDatabase } from '@/lib/db';
import { hasWix } from '@/lib/wix/config';
import { runContactTeamPipeline } from '@/lib/wix-sync/pipeline';

function extractContactId(req: NextApiRequest): string | undefined {
  const b: any = req.body ?? {};
  return (
    b.contactId || b.contact_id || b.id || b.contact?.id ||
    (req.query.contactId as string) || (req.query.contact_id as string)
  );
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const secret = process.env.WIX_SYNC_WEBHOOK_SECRET;
  const provided = (req.headers['x-webhook-secret'] as string) || (req.query.secret as string);
  if (!secret || provided !== secret) return res.status(401).json({ error: 'unauthorized' });

  if (!hasDatabase) return res.status(503).json({ error: 'database not configured' });
  if (!hasWix) return res.status(503).json({ error: 'Wix not configured' });

  const contactId = extractContactId(req);
  if (!contactId) return res.status(400).json({ error: 'contactId required' });
  const dryRun = req.query.dryRun === '1' || (req.body && req.body.dryRun === true);

  try {
    const catalogs = await getCatalogs();
    const r = await runContactTeamPipeline(String(contactId), catalogs.contact, { apply: !dryRun });
    return res.status(200).json({ ok: true, dryRun, contactId, enrich: r.enrich, sets: r.sets });
  } catch (e: any) {
    console.error('wix-sync error:', e);
    return res.status(500).json({ error: e?.message ?? 'wix sync failed' });
  }
}
