// pages/api/wix-sync.ts — real-time GHL -> Wix CMS sync webhook.
//
// GHL "Contact Changed" workflow -> Webhook action POSTs { contactId } here. We run every
// ENABLED Wix mapping set whose source object is `contact`, upserting the matching row in
// each set's Wix collection (equality-guarded, so idempotent). Mirrors pages/api/sync/up.ts.
//
// Auth: shared secret in `x-webhook-secret` header (or `?secret=`) vs WIX_SYNC_WEBHOOK_SECRET.
// Configure the GHL webhook body as { "contactId": "{{contact.id}}" }. Add ?dryRun=1 to preview.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getCatalogs } from '@/lib/ghl/catalogCache';
import { hasDatabase } from '@/lib/db';
import { getWixStore } from '@/lib/mapping/wixStore';
import { hasWix } from '@/lib/wix/config';
import { getWixCollectionSchema } from '@/lib/wix/catalogCache';
import { syncContactToWix } from '@/lib/wix-sync';

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
    const sets = await getWixStore().setsForSource('contact');
    if (!sets.length) return res.status(200).json({ ok: true, dryRun, contactId, sets: [], note: 'no enabled contact->Wix sets' });

    const results = [];
    for (const set of sets) {
      try {
        const schema = await getWixCollectionSchema(set.wixCollectionId);
        const r = await syncContactToWix(String(contactId), set, catalogs.contact, schema, { apply: !dryRun });
        results.push({
          set: set.name, collection: set.wixCollectionId, action: r.action,
          written: r.written.map((w) => w.targetColumn), unchanged: r.unchanged,
          skipped: r.skipped, itemId: r.itemId, note: r.note,
        });
      } catch (e: any) {
        results.push({ set: set.name, collection: set.wixCollectionId, error: e?.message ?? 'sync failed' });
      }
    }

    return res.status(200).json({ ok: true, dryRun, contactId, sets: results });
  } catch (e: any) {
    console.error('wix-sync error:', e);
    return res.status(500).json({ error: e?.message ?? 'wix sync failed' });
  }
}
