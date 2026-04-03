// pages/api/activities/list.ts — List/filter activity records from GHL
// TODO: Implement GET handler with date range, activity type, grant, and owner filters
import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.status(501).json({ error: 'Not implemented' });
}
