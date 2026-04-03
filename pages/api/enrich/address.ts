// pages/api/enrich/address.ts — Census Geocoder + ArcGIS lookup endpoint
import type { NextApiRequest, NextApiResponse } from 'next';
import { enrichAddress } from '@/lib/enrich';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { address1, city, state, postal_code } = req.body;

  if (!address1 || !city || !state) {
    return res.status(400).json({ error: 'address1, city, and state are required' });
  }

  try {
    const result = await enrichAddress(address1, city, state, postal_code ?? '');
    res.status(200).json(result);
  } catch (error: any) {
    console.error('Enrich error:', error);
    res.status(500).json({ error: error.message ?? 'Enrichment failed' });
  }
}
