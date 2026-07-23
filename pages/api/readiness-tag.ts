// pages/api/readiness-tag.ts — real-time readiness-tagger webhook.
//
// GHL "Contact Changed" workflow -> Webhook action POSTs { contactId } here. We run the
// readiness-tagger over that contact: membership-gated (config `membership.anyOf`, default Team/EIR
// only), AI-classified service tags, code-derived stops, written to the 7 GHL readiness fields
// (equality-guarded => idempotent). Mirrors pages/api/wix-sync.ts. This manual/real-time endpoint
// applies the MEMBERSHIP gate only (no status gate) so it can re-tag an in-scope coach on demand.
//
// Auth: shared secret in `x-webhook-secret` header (or `?secret=`) vs READINESS_WEBHOOK_SECRET.
// Configure the GHL webhook body as { "contactId": "{{contact.id}}" }. Add ?dryRun=1 to preview.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getCatalogs } from '@/lib/ghl/catalogCache';
import { getContact } from '@/lib/ghl/contacts';
import { enrichContact, readContactField } from '@/lib/enrichment/contactEngine';
import { readinessTagger } from '@/lib/enrichment/enrichers/readinessTagger';
import { resolveEnricherConfig } from '@/lib/enrichment/configStore';
import { membershipMatches } from '@/lib/enrichment/gate';
import { hasAnthropic } from '@/lib/ai/anthropic';

function extractContactId(req: NextApiRequest): string | undefined {
  const b: any = req.body ?? {};
  return (
    b.contactId || b.contact_id || b.id || b.contact?.id ||
    (req.query.contactId as string) || (req.query.contact_id as string)
  );
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const secret = process.env.READINESS_WEBHOOK_SECRET;
  const provided = (req.headers['x-webhook-secret'] as string) || (req.query.secret as string);
  if (!secret || provided !== secret) return res.status(401).json({ error: 'unauthorized' });

  if (!hasAnthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const contactId = extractContactId(req);
  if (!contactId) return res.status(400).json({ error: 'contactId required' });
  const dryRun = req.query.dryRun === '1' || (req.body && req.body.dryRun === true);

  try {
    const catalogs = await getCatalogs();

    // Membership gate (config-driven; enricher no longer self-gates). Board-only contacts get nothing.
    const config = await resolveEnricherConfig('readiness-tagger', 'contact');
    const contact = await getContact(String(contactId), undefined);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    if (config.membership?.field && config.membership.anyOf?.length) {
      const membership = readContactField(contact, catalogs.contact, config.membership.field);
      if (!membershipMatches(membership, config.membership.anyOf)) {
        return res.status(200).json({ ok: true, dryRun, contactId, didWrite: false, applied: [], skipped: [], note: `membership gate: not in {${config.membership.anyOf.join(',')}}` });
      }
    }

    const result = await enrichContact(
      String(contactId),
      [readinessTagger],
      catalogs.contact,
      { mode: 'overwrite' },
      { apply: !dryRun },
    );
    return res.status(200).json({
      ok: true,
      dryRun,
      contactId,
      didWrite: result.didWrite,
      applied: result.applied.map((a) => a.contactKey),
      skipped: result.skipped,
      // note when nothing was produced (e.g. Board-only contact fails the membership gate)
      note: result.proposals.length === 0 ? 'no proposals (membership gate skipped, or nothing to classify)' : undefined,
    });
  } catch (e: any) {
    console.error('readiness-tag error:', e);
    return res.status(500).json({ error: e?.message ?? 'readiness tagging failed' });
  }
}
