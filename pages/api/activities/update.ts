// pages/api/activities/update.ts — edit a logged activity.
//
// Goes through writeRecordFields (→ applyObjectWrite), which is the ONLY safe way to update this
// object: `referral_type` and `program__grant_association` are MULTIPLE_OPTIONS, and on update those
// need an {add,remove} diff. v1 sent plain arrays here — a 422 at best, and a wiped field if a lone
// string ever reached it. The diff also makes an unchanged re-save a genuine no-op.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getCatalog } from '@/lib/ghl/catalogCache';
import { writeRecordFields } from '@/lib/ghl/writeRecord';
import { readRecordFields } from '@/lib/ghl/records';
import { logChange } from '@/lib/audit/log';
import { ACTIVITIES_OBJECT } from '@/lib/activities/schema';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PUT' && req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });

  const { id, values, actor } = req.body ?? {};
  if (!id) return res.status(400).json({ error: 'Record ID required' });
  const changes = (values ?? {}) as Record<string, unknown>;
  if (!Object.keys(changes).length) return res.status(400).json({ error: 'No values to update' });

  try {
    const catalog = await getCatalog(ACTIVITIES_OBJECT);
    const before = await readRecordFields(ACTIVITIES_OBJECT, String(id));
    const result = await writeRecordFields(ACTIVITIES_OBJECT, String(id), changes, catalog);

    const actorName = actor?.name?.trim() || actor?.email?.trim() || 'staff';
    await logChange({
      objectType: ACTIVITIES_OBJECT,
      recordId: String(id),
      recordLabel: String(before.get('activity_name') ?? '') || undefined,
      actorKind: 'staff',
      actorName,
      action: 'update',
      changes: result.written.map((key) => ({
        field: `${ACTIVITIES_OBJECT}.${key}`,
        from: before.get(key),
        to: changes[key] ?? changes[`${ACTIVITIES_OBJECT}.${key}`],
      })),
    });

    // written: [] with nothing skipped means every field already held the desired value.
    const noop = result.written.length === 0 && result.skipped.length === 0;
    res.status(200).json({ success: true, noop, ...result });
  } catch (error: any) {
    console.error('Activity update error:', error);
    res.status(500).json({ error: error.message ?? 'Failed to update activity' });
  }
}
