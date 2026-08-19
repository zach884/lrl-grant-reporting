// pages/api/opportunity-sync.ts — a GHL pipeline stage change → a Program Acceptance / Grant activity.
//
// Wire a GHL workflow on the "Opportunity Status/Stage Changed" trigger with a Custom Webhook action:
//     POST https://lrl-grant-reporting.vercel.app/api/opportunity-sync
//     { "opportunityId": "{{opportunity.id}}" }
// Auth: shared secret in `x-webhook-secret` (or `?secret=`). `?dryRun=1` previews · `?sync=1` waits ·
// `?echo=1` dumps the delivered payload and runs nothing.
//
// WIRE THIS EARLY. An opportunity is only ever in ONE stage, so stage history is not recoverable
// after the fact: of 97 LOCAL Fellows opportunities, zero still sit in "Selected for Bootcamp".
// Unlike appointments — where the past is sitting in the calendar waiting to be backfilled — every
// week without this webhook is history that can only be approximated.

import type { NextApiRequest, NextApiResponse } from 'next';
import { ackAndRun, wantsAsync } from '@/lib/webhooks/fastAck';
import { ingestOpportunityById } from '@/lib/activities/sources/opportunityStage';

const GHL_ID = /^[A-Za-z0-9]{15,30}$/;

function extractOpportunityId(req: NextApiRequest): { id?: string; via?: string } {
  const q = req.query.opportunityId ?? req.query.id;
  if (typeof q === 'string' && q) return { id: q, via: 'query' };
  const body = (req.body ?? {}) as Record<string, any>;
  for (const key of ['opportunityId', 'opportunity_id', 'id', 'recordId']) {
    const v = body[key];
    if (typeof v === 'string' && GHL_ID.test(v)) return { id: v, via: `body.${key}` };
  }
  const nested = body.opportunity?.id;
  if (typeof nested === 'string' && GHL_ID.test(nested)) return { id: nested, via: 'body.opportunity.id' };
  return {};
}

function authorized(req: NextApiRequest): boolean {
  const expected = process.env.WIX_SYNC_WEBHOOK_SECRET;
  if (!expected) return true;
  const got = req.headers['x-webhook-secret'] ?? req.query.secret;
  return typeof got === 'string' && got === expected;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.query.echo === '1') {
    return res.status(200).json({ echo: true, query: req.query, body: req.body });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { id, via } = extractOpportunityId(req);
  if (!id) {
    return res.status(400).json({ error: 'No opportunity id in the payload. Send {"opportunityId":"{{opportunity.id}}"}, or call with ?echo=1 to see what GHL is delivering.' });
  }

  const dryRun = req.query.dryRun === '1' || (req.body as any)?.dryRun === true;
  const work = () => ingestOpportunityById(id, { dryRun });

  if (wantsAsync(req)) {
    ackAndRun(res, work, { label: 'opportunity-sync', detail: { opportunityId: id, via } });
    return;
  }
  try {
    res.status(200).json({ ok: true, via, dryRun, ...(await work()) });
  } catch (error: any) {
    console.error('opportunity-sync error:', error);
    res.status(500).json({ error: error.message ?? 'Failed to ingest opportunity' });
  }
}
