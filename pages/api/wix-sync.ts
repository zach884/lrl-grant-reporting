// pages/api/wix-sync.ts — real-time contact ENRICH + Wix CMS sync webhook.
//
// GHL "Contact Changed" workflow -> Webhook action POSTs { contactId } here. This is the single
// app entry point for the contact→Team pipeline. It does two things, in order:
//   1. ENRICH (only when contact.status === "Approved"): run the readiness-tagger so the contact's
//      service_areas + subway stops are fresh on the GHL contact BEFORE we push to Wix. Gated on
//      Approved so we don't spend AI credits on every unrelated edit; the tagger also self-limits
//      to Team/EIR coaches (Board are synced but not tagged).
//   2. SYNC: run every ENABLED contact Wix mapping set. The set's contact.status GATE decides the
//      action per contact (Approved→upsert+publish→writeback Published · Published→update ·
//      Hidden→hide · Pending/other→skip). Equality-guarded, so idempotent.
//
// Auth: shared secret in `x-webhook-secret` header (or `?secret=`) vs WIX_SYNC_WEBHOOK_SECRET.
// Configure the GHL webhook body as { "contactId": "{{contact.id}}" }. Add ?dryRun=1 to preview.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getCatalogs } from '@/lib/ghl/catalogCache';
import { getContact } from '@/lib/ghl/contacts';
import { hasDatabase } from '@/lib/db';
import { getWixStore } from '@/lib/mapping/wixStore';
import { hasWix } from '@/lib/wix/config';
import { getWixCollectionSchema } from '@/lib/wix/catalogCache';
import { syncContactToWix } from '@/lib/wix-sync';
import { enrichContact, readContactField } from '@/lib/enrichment/contactEngine';
import { readinessTagger } from '@/lib/enrichment/enrichers/readinessTagger';
import { hasAnthropic } from '@/lib/ai/anthropic';

/** Contact.status values that trigger (re-)enrichment. Kept in sync with the set gate's upsert value. */
const ENRICH_ON_STATUS = new Set(['Approved']);

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

    // STEP 1 — enrich, but only when the contact is Approved (credit gate). The tagger self-limits
    // to Team/EIR coaches, so Board/others no-op. Runs before the sync so fresh tags flow to Wix.
    let enrich: { ran: boolean; status: string; applied?: string[]; note?: string } = { ran: false, status: '' };
    const contact = await getContact(String(contactId));
    const status = String(contact ? readContactField(contact, catalogs.contact, 'contact.status') ?? '' : '');
    enrich.status = status;
    if (!contact) {
      enrich.note = 'contact not found';
    } else if (ENRICH_ON_STATUS.has(status) && hasAnthropic) {
      const r = await enrichContact(String(contactId), [readinessTagger], catalogs.contact, { mode: 'overwrite' }, { apply: !dryRun });
      enrich = { ran: true, status, applied: r.applied.map((a) => a.contactKey) };
    } else {
      enrich.note = !hasAnthropic ? 'ANTHROPIC_API_KEY not set' : `status "${status}" not in {${Array.from(ENRICH_ON_STATUS).join(',')}} — no enrich`;
    }

    // STEP 2 — sync every enabled contact set (the set gate decides upsert/update/hide/skip).
    const sets = await getWixStore().setsForSource('contact');
    if (!sets.length) return res.status(200).json({ ok: true, dryRun, contactId, enrich, sets: [], note: 'no enabled contact->Wix sets' });

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

    return res.status(200).json({ ok: true, dryRun, contactId, enrich, sets: results });
  } catch (e: any) {
    console.error('wix-sync error:', e);
    return res.status(500).json({ error: e?.message ?? 'wix sync failed' });
  }
}
