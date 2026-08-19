// pages/api/activities/list.ts — a company's timeline, or the recent feed across all companies.

import type { NextApiRequest, NextApiResponse } from 'next';
import { listActivitiesForCompany, listRecentActivities } from '@/lib/activities/list';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const companyId = String(req.query.companyId ?? '').trim();
  const type = String(req.query.type ?? '').trim();
  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 100);

  try {
    const activities = companyId
      ? await listActivitiesForCompany(companyId)
      : await listRecentActivities(limit);
    res.status(200).json({ activities: type ? activities.filter((a) => a.type === type) : activities });
  } catch (error: any) {
    console.error('Activity list error:', error);
    res.status(500).json({ error: error.message ?? 'Failed to list activities' });
  }
}
