// pages/api/enrich/address.ts — Census Geocoder + ArcGIS lookup endpoint
// TODO: Implement address enrichment API route
import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.status(501).json({ error: 'Not implemented' });
}
