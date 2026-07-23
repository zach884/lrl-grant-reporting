// pages/api/resource-sync.ts — standalone Resource ENRICH + Wix Resources sync webhook.
//
// The Team pattern, one object over: runs the resource pipeline (lib/wix-sync/pipeline
// runResourcePipeline) — enrich the resource-tagger when its config gate passes (default
// resource_status=Approved), then sync every enabled custom_objects.resources → Wix set (each set's
// resource_status gate decides upsert/update/hide/skip). GHL "Resource Changed" workflow → this hook.
//
// Auth: shared secret in `x-webhook-secret` header (or `?secret=`) vs WIX_SYNC_WEBHOOK_SECRET.
// Body: { "recordId": "{{record.id}}" }. Add ?dryRun=1 to preview.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getCatalog } from '@/lib/ghl/catalogCache';
import { hasDatabase } from '@/lib/db';
import { hasWix } from '@/lib/wix/config';
import { runResourcePipeline } from '@/lib/wix-sync/pipeline';

const RES_OBJ = 'custom_objects.resources';

function extractRecordId(req: NextApiRequest): string | undefined {
  const b: any = req.body ?? {};
  return b.recordId || b.record_id || b.id || b.record?.id || (req.query.recordId as string) || (req.query.id as string);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const secret = process.env.WIX_SYNC_WEBHOOK_SECRET;
  const provided = (req.headers['x-webhook-secret'] as string) || (req.query.secret as string);
  if (!secret || provided !== secret) return res.status(401).json({ error: 'unauthorized' });

  if (!hasDatabase) return res.status(503).json({ error: 'database not configured' });
  if (!hasWix) return res.status(503).json({ error: 'Wix not configured' });

  const recordId = extractRecordId(req);
  if (!recordId) return res.status(400).json({ error: 'recordId required' });
  const dryRun = req.query.dryRun === '1' || (req.body && req.body.dryRun === true);

  try {
    const catalog = await getCatalog(RES_OBJ);
    const r = await runResourcePipeline(String(recordId), catalog, { apply: !dryRun });
    return res.status(200).json({ ok: true, dryRun, recordId, enrich: r.enrich, sets: r.sets });
  } catch (e: any) {
    console.error('resource-sync error:', e);
    return res.status(500).json({ error: e?.message ?? 'resource sync failed' });
  }
}
