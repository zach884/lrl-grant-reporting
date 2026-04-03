// pages/api/activities/delete.ts — Delete activity record
// TODO: Implement DELETE handler to remove GHL Custom Object record
import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.status(501).json({ error: 'Not implemented' });
}
