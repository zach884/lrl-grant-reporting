// pages/api/contacts/search.ts — GHL contact search endpoint
// TODO: Implement GET handler that searches GHL contacts by query string
import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.status(501).json({ error: 'Not implemented' });
}
