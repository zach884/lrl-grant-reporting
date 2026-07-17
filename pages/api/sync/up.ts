// pages/api/sync/up.ts — real-time UP-sync webhook.
//
// GHL "Contact Changed" workflow -> Webhook action POSTs { contactId } here. We push the
// contact's mapped fields UP to its company (equality-guarded); if the company actually
// changed, we fan the new state DOWN to the company's other contacts (roster from the
// associations graph). Both directions are equality-guarded, so it's idempotent and can't
// ping-pong.
//
// Auth: shared secret in the `x-webhook-secret` header (or `?secret=`), compared to
// SYNC_WEBHOOK_SECRET. Configure the GHL webhook body as e.g. { "contactId": "{{contact.id}}" }.
// Add `?dryRun=1` to preview writes without applying.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getCatalogs } from '@/lib/ghl/catalogCache';
import { mappingStore } from '@/lib/mapping';
import { syncContactUpAndFanOut } from '@/lib/sync';
import { applyContactChange, useGenericEngine } from '@/lib/sync/orchestrate';
import { enrichCompany, defaultEnrichers } from '@/lib/enrichment';

function extractContactId(req: NextApiRequest): string | undefined {
  const b: any = req.body ?? {};
  return (
    b.contactId || b.contact_id || b.id ||
    b.contact?.id ||
    (req.query.contactId as string) || (req.query.contact_id as string)
  );
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const secret = process.env.SYNC_WEBHOOK_SECRET;
  const provided = (req.headers['x-webhook-secret'] as string) || (req.query.secret as string);
  if (!secret || provided !== secret) return res.status(401).json({ error: 'unauthorized' });

  const contactId = extractContactId(req);
  if (!contactId) return res.status(400).json({ error: 'contactId required' });
  const dryRun = req.query.dryRun === '1' || (req.body && req.body.dryRun === true);

  try {
    const catalogs = await getCatalogs();

    // Cutover flag: SYNC_ENGINE_MODE=generic drives the two push connections through the
    // object-agnostic engine; otherwise the proven built-in engine. Both are equality-guarded.
    // `companyId`, `companyFieldsWritten` (bare keys), and the response payload are normalized so
    // the enrichment gate + JSON shape are identical either way.
    let companyId: string | undefined;
    let companyFieldsWritten: string[];
    let upResp: Record<string, unknown>;
    let downResp: Record<string, unknown> | null;

    if (useGenericEngine()) {
      const r = await applyContactChange(String(contactId), { apply: !dryRun });
      companyId = r.companyId;
      companyFieldsWritten = r.companyFieldsWritten;
      const fwd = r.up.forward[0];
      upResp = { engine: 'generic', written: companyFieldsWritten, unchanged: fwd?.unchanged ?? 0, drift: fwd?.changes ?? [], skipped: fwd?.skipped ?? [], note: r.up.note };
      downResp = r.down
        ? {
            contacts: r.down.counterpartCount,
            contactsChanged: r.down.forward.filter((f) => (dryRun ? f.changes.length : f.written.length) > 0).length,
            fieldsWritten: r.down.forward.reduce((n, f) => n + (dryRun ? f.changes.length : f.written.length), 0),
          }
        : null;
    } else {
      const set = await mappingStore.load();
      const { up, down } = await syncContactUpAndFanOut(String(contactId), set.mappings, catalogs, { apply: !dryRun });
      companyId = up.companyId;
      companyFieldsWritten = up.written.map((k) => k.replace(/^business\./, ''));
      upResp = { engine: 'builtin', written: up.written, unchanged: up.unchanged, drift: up.drift, skipped: up.skipped, note: up.note };
      downResp = down
        ? {
            contacts: down.contactCount,
            contactsChanged: down.results.filter((r) => r.written.length > 0 || r.companyNameWritten).length,
            fieldsWritten: down.results.reduce((n, r) => n + r.written.length + (r.companyNameWritten ? 1 : 0), 0),
          }
        : null;
    }

    // Real-time enrichment of the touched company. Address-dependent enrichers (county,
    // geo-zone) only run when the company address actually changed this sync — that's the
    // only thing that can change their result, and it avoids geocoding on every unrelated
    // contact edit. Address-independent enrichers (NAICS) always run (they self-gate cheaply).
    // Non-fatal: enrichment failures must never break the sync.
    const ADDRESS_KEYS = new Set(['address', 'address1', 'city', 'state', 'postalcode', 'zip', 'country']);
    const addressChanged = companyFieldsWritten.some((k) => ADDRESS_KEYS.has(k.toLowerCase()));
    const enrichers = addressChanged ? defaultEnrichers : defaultEnrichers.filter((e) => !e.addressDependent);
    let enrich: { applied: number; skipped: number; fields: string[]; addressChanged: boolean } | { error: string } | null = null;
    if (companyId && enrichers.length) {
      try {
        const r = await enrichCompany(
          companyId,
          enrichers,
          catalogs.business,
          { mode: 'overwrite', minConfidence: 0.7 },
          { apply: !dryRun },
        );
        enrich = { applied: r.applied.length, skipped: r.skipped.length, fields: r.applied.map((a) => a.businessKey), addressChanged };
      } catch (e: any) {
        enrich = { error: e?.message ?? 'enrichment failed' };
      }
    }

    return res.status(200).json({ ok: true, dryRun, contactId, companyId, up: upResp, down: downResp, enrich });
  } catch (e: any) {
    console.error('sync/up error:', e);
    return res.status(500).json({ error: e?.message ?? 'sync failed' });
  }
}
