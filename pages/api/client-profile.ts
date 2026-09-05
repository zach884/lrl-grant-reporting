// pages/api/client-profile.ts — the ONLY endpoint the client rescore page talks to.
//
// Auth is a signed client token (lib/security/clientToken.ts). Allowlisted in middleware.ts as
// self-enforcing, so this file is the entire door: get it wrong and a company profile is public.
//
// The rules that matter here:
//  - contactId and businessId come from the VERIFIED TOKEN, never from the request. There is no
//    "which company" parameter, by design.
//  - Only fields the routed profile offered can be written (diffSubmission drops the rest).
//  - Only CHANGED fields are sent — writeRecordFields sends every scalar it is handed, so an
//    undiffed submit would rewrite the record on every save and make `noop` unreachable.
//  - Writes go through setBusinessFields -> applyObjectWrite, which verifies by read-back. A GHL
//    field that accepts a write and stores nothing comes back `skipped`, never `applied`.
//
//   GET  /api/client-profile?t=<token>   -> { profile }
//   POST /api/client-profile             -> { t, values } -> writes, rescores, tags, { scores }

import type { NextApiRequest, NextApiResponse } from 'next';
import { ghl } from '@/lib/ghl/client';
import { getCatalog } from '@/lib/ghl/catalogCache';
import { setBusinessFields } from '@/lib/ghl/businesses';
import { addContactTags } from '@/lib/ghl/contacts';
import { hasClientLinkSecret, verifyClientToken } from '@/lib/security/clientToken';
import { diffSubmission, loadClientProfile } from '@/lib/clientProfile/profile';
import { runStageScoreTrigger } from '@/lib/stage/trigger';

/** Tag applied on a successful rescore. This is the trigger for the follow-up email workflow. */
export const RESCORE_TAG = 'rescore-submitted';

function tokenFrom(req: NextApiRequest): string | undefined {
  const q = req.query.t;
  if (typeof q === 'string' && q) return q;
  const b = req.body?.t;
  return typeof b === 'string' && b ? b : undefined;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Never let a client profile sit in a CDN or a shared proxy cache.
  res.setHeader('Cache-Control', 'no-store, private');

  if (!hasClientLinkSecret()) return res.status(503).json({ error: 'client links are not configured' });

  const payload = await verifyClientToken(tokenFrom(req));
  // Deliberately uninformative: expired, tampered and malformed are indistinguishable from outside.
  if (!payload) return res.status(401).json({ error: 'This link is not valid or has expired.' });

  const client = ghl();
  const catalog = await getCatalog('business', { client });

  try {
    if (req.method === 'GET') {
      const profile = await loadClientProfile(payload.b, catalog, client);
      return res.status(200).json({ ok: true, profile });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });

    const values = (req.body?.values ?? {}) as Record<string, unknown>;
    const profile = await loadClientProfile(payload.b, catalog, client);
    const { changed, unchanged } = diffSubmission(profile, values);

    // business_model is not a scoring INPUT, it is the router, so it is handled separately — and only
    // when the company has none. Changing an existing one is a staff decision, not a client one.
    const submittedModel = String(values.business_model ?? '').trim();
    if (!profile.path && submittedModel) changed.business_model = submittedModel;

    let write: { written: string[]; skipped: Array<{ key: string; reason: string }> } = { written: [], skipped: [] };
    if (Object.keys(changed).length) {
      const coerced = await setBusinessFields(payload.b, changed, catalog.byKey, client);
      write = {
        written: Object.keys(changed).filter((k) => !coerced.skipped.some((s) => s.key === k)),
        skipped: coerced.skipped.map((s) => ({ key: s.key, reason: s.reason })),
      };
    }

    // force: the client just told us these answers are current. The input fingerprint may be
    // unchanged (they confirmed rather than edited) and we still want today's record to say so.
    const scored = Object.keys(changed).length
      ? await runStageScoreTrigger(payload.b, { apply: true, client, businessCatalog: catalog, force: true })
      : { ran: false, reason: 'nothing changed' as string };

    // Best effort, and last: the follow-up email must never be the reason a rescore 500s.
    let tagged = false;
    try {
      await addContactTags(payload.c, [RESCORE_TAG], client);
      tagged = true;
    } catch (e: any) {
      console.error('client-profile: tag failed', e?.message ?? e);
    }

    return res.status(200).json({
      ok: true,
      changed: Object.keys(changed),
      unchanged,
      written: write.written,
      skipped: write.skipped,
      rescored: scored,
      tagged,
    });
  } catch (e: any) {
    console.error('client-profile error:', e);
    return res.status(500).json({ error: 'Something went wrong saving your answers.' });
  }
}
