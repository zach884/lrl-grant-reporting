// pages/api/activities/create.ts — Create GHL Custom Object record
// TODO: Implement POST handler to create activity in GHL and trigger sheet append
import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.status(501).json({ error: 'Not implemented' });
}
