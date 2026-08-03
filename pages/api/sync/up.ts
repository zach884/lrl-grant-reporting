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
import { applyContactChange } from '@/lib/sync/orchestrate';
import { enrichCompany, defaultEnrichers } from '@/lib/enrichment';
import { runStageScoreTrigger } from '@/lib/stage/trigger';
import { hasDatabase } from '@/lib/db';
import { hasWix } from '@/lib/wix/config';
import { runContactTeamPipeline } from '@/lib/wix-sync/pipeline';

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

    // Contact changed → push UP to its primary company; if the company changed, fan OUT down to all
    // its contacts. Equality-guarded end to end, so it's idempotent and can't ping-pong.
    const r = await applyContactChange(String(contactId), { apply: !dryRun });
    const companyId = r.companyId;
    const companyFieldsWritten = r.companyFieldsWritten;
    const fwd = r.up.forward[0];
    const upResp: Record<string, unknown> = { written: companyFieldsWritten, unchanged: fwd?.unchanged ?? 0, drift: fwd?.changes ?? [], skipped: fwd?.skipped ?? [], note: r.up.note };
    const downResp: Record<string, unknown> | null = r.down
      ? {
          contacts: r.down.counterpartCount,
          contactsChanged: r.down.forward.filter((f) => (dryRun ? f.changes.length : f.written.length) > 0).length,
          fieldsWritten: r.down.forward.reduce((n, f) => n + (dryRun ? f.changes.length : f.written.length), 0),
        }
      : null;

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

    // Client Stage scorer: when a scoring input changed on the company, (re)score it and upsert today's
    // Client Stage Tracking record. Company-scoped but triggered by the contact change. Config-gated
    // (enabled + gate) and change-gated (only fires when a field that feeds the score changed), so a
    // normal contact edit does NOT spend a Claude call. Non-fatal + isolated like the enrichers above.
    let stageScore: unknown = null;
    if (companyId) {
      try {
        stageScore = await runStageScoreTrigger(companyId, {
          apply: !dryRun,
          changedFields: companyFieldsWritten,
          businessCatalog: catalogs.business,
        });
      } catch (e: any) {
        stageScore = { error: e?.message ?? 'stage scoring failed' };
      }
    }

    // Contact → Team pipeline: readiness enrich (on status=Approved) + Wix Team sync. This makes
    // ONE "Contact Changed" webhook fan out to everything. Non-fatal + isolated: any failure here
    // must never break the company up/down sync above, so it's wrapped and only runs when the DB +
    // Wix are configured. (The same pipeline is also exposed standalone at /api/wix-sync.)
    let readiness: unknown = null;
    if (hasDatabase && hasWix) {
      try {
        readiness = await runContactTeamPipeline(String(contactId), catalogs.contact, { apply: !dryRun });
      } catch (e: any) {
        readiness = { error: e?.message ?? 'readiness/Wix pipeline failed' };
      }
    }

    return res.status(200).json({ ok: true, dryRun, contactId, companyId, up: upResp, down: downResp, enrich, stageScore, readiness });
  } catch (e: any) {
    console.error('sync/up error:', e);
    return res.status(500).json({ error: e?.message ?? 'sync failed' });
  }
}
