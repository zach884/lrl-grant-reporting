// pages/api/form-sync.ts — a GHL form submission → a Grant or Metrics activity.
//
// Wire the workflow that already fires on each form (Zach: the Direct Grant Application workflow
// exists, it just has no webhook yet) with a Custom Webhook action:
//     POST https://lrl-grant-reporting.vercel.app/api/form-sync
//     { "contactId": "{{contact.id}}", "formId": "<the form's id>" }
// Auth: shared secret in `x-webhook-secret` (or `?secret=`). `?dryRun=1` previews · `?sync=1` waits ·
// `?echo=1` dumps what GHL delivered and runs nothing.
//
// The form id decides which activity type this becomes (`activity_routes`, matchKind `form`), so a
// new form is a config row rather than a deploy. If the workflow cannot send the form id, put it in
// the URL: `/api/form-sync?formId=ed03BbRGWrc6Ugtwr9JB`.

import type { NextApiRequest, NextApiResponse } from 'next';
import { ackAndRun, wantsAsync } from '@/lib/webhooks/fastAck';
import { ingestFormSubmission } from '@/lib/activities/sources/form';

const GHL_ID = /^[A-Za-z0-9]{15,30}$/;

function extract(req: NextApiRequest): { contactId?: string; formId?: string; via?: string } {
  const body = (req.body ?? {}) as Record<string, any>;
  const q = req.query;
  const formId = (typeof q.formId === 'string' && q.formId) || body.formId || body.form_id || body.form?.id;
  for (const key of ['contactId', 'contact_id', 'id']) {
    const v = body[key];
    if (typeof v === 'string' && GHL_ID.test(v)) return { contactId: v, formId, via: `body.${key}` };
  }
  const nested = body.contact?.id;
  if (typeof nested === 'string' && GHL_ID.test(nested)) return { contactId: nested, formId, via: 'body.contact.id' };
  if (typeof q.contactId === 'string' && q.contactId) return { contactId: q.contactId, formId, via: 'query' };
  return { formId };
}

function authorized(req: NextApiRequest): boolean {
  const expected = process.env.WIX_SYNC_WEBHOOK_SECRET;
  if (!expected) return true;
  const got = req.headers['x-webhook-secret'] ?? req.query.secret;
  return typeof got === 'string' && got === expected;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.query.echo === '1') return res.status(200).json({ echo: true, query: req.query, body: req.body });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { contactId, formId, via } = extract(req);
  if (!contactId) {
    return res.status(400).json({ error: 'No contact id in the payload. Send {"contactId":"{{contact.id}}","formId":"<form id>"}, or call with ?echo=1 to see what GHL delivers.' });
  }

  const dryRun = req.query.dryRun === '1' || (req.body as any)?.dryRun === true;
  const work = () => ingestFormSubmission({ contactId, formId }, { dryRun });

  if (wantsAsync(req)) {
    ackAndRun(res, work, { label: 'form-sync', detail: { contactId, formId, via } });
    return;
  }
  try {
    res.status(200).json({ ok: true, via, dryRun, ...(await work()) });
  } catch (error: any) {
    console.error('form-sync error:', error);
    res.status(500).json({ error: error.message ?? 'Failed to ingest form submission' });
  }
}
