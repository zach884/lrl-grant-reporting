// pages/api/activities/delete.ts — remove a logged activity (a mis-logged entry, or a live test row).
//
// Deletion is the one activity write with no undo, so it is logged like every other change: the
// change_log row records what was removed and who removed it.

import type { NextApiRequest, NextApiResponse } from 'next';
import { deleteObjectRecord } from '@/lib/ghl/createRecord';
import { readRecordFields } from '@/lib/ghl/records';
import { logChange } from '@/lib/audit/log';
import { ACTIVITIES_OBJECT } from '@/lib/activities/schema';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });

  const id = String(req.query.id ?? '');
  if (!id) return res.status(400).json({ error: 'Record ID required' });
  const actorName = String(req.query.actor ?? '').trim() || 'staff';

  try {
    // Read first: once it's gone there is nothing left to describe in the log.
    const before = await readRecordFields(ACTIVITIES_OBJECT, id).catch(() => null);
    await deleteObjectRecord(ACTIVITIES_OBJECT, id);
    await logChange({
      objectType: ACTIVITIES_OBJECT,
      recordId: id,
      recordLabel: before ? String(before.get('activity_name') ?? '') || undefined : undefined,
      actorKind: 'staff',
      actorName,
      action: 'update',
      changes: [{ field: 'record', from: before?.values ?? null, to: null, rationale: 'activity deleted' }],
    });
    res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('Activity delete error:', error);
    res.status(500).json({ error: error.message ?? 'Failed to delete activity' });
  }
}
