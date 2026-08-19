// pages/api/activities/create.ts — log one activity.
//
// Thin on purpose: every rule (validation, coercion, read-back, associations, audit) lives in
// lib/activities/create so the API, a future webhook and any script all behave identically.

import type { NextApiRequest, NextApiResponse } from 'next';
import { createActivity, ActivityValidationError } from '@/lib/activities/create';
import { SOURCE_FIELD } from '@/lib/activities/upsert';
import { expandReferredTo } from '@/lib/activities/referral';
import type { ReferredTo } from '@/lib/activities/schema';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { type, companyId, contactIds, referredTo, referredToContactId, values, actor } = req.body ?? {};
  try {
    // Picking a Resource implies the company behind it, when that link is known — so the referral is
    // joinable by organization and not only by directory row.
    const targets = Array.isArray(referredTo) ? await expandReferredTo(referredTo as ReferredTo[]) : [];
    const result = await createActivity(
      {
        type: String(type ?? ''),
        companyId: String(companyId ?? ''),
        contactIds: Array.isArray(contactIds) ? contactIds.map(String) : [],
        referredTo: targets,
        referredToContactId: referredToContactId ? String(referredToContactId) : undefined,
        // Stamp the source so a hand-logged record is distinguishable from an ingested one — both
        // in the timeline and in any report that needs to know where a number came from.
        values: { ...((values ?? {}) as Record<string, unknown>), [SOURCE_FIELD]: 'Manual' },
      },
      { actor },
    );
    // A record that saved but couldn't be linked to its company is NOT a success: it is invisible
    // to every funder report. Say so loudly rather than showing a green tick.
    const brokenLinks = result.links.filter((l) => l.status === 'failed');
    res.status(200).json({ success: brokenLinks.length === 0, ...result });
  } catch (error: any) {
    if (error instanceof ActivityValidationError) {
      return res.status(400).json({ error: 'Incomplete activity', errors: error.errors });
    }
    console.error('Activity create error:', error);
    res.status(500).json({ error: error.message ?? 'Failed to create activity' });
  }
}
