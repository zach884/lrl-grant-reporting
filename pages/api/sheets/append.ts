// pages/api/sheets/append.ts — Append row to grant reporting sheet
// TODO: Implement sheet append logic using field_mapping and reporting_periods config
import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.status(501).json({ error: 'Not implemented' });
}
