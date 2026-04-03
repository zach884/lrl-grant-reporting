// pages/api/activities/delete.ts — Delete activity record
import type { NextApiRequest, NextApiResponse } from 'next';
import { ghlRequest, GHL_LOCATION_ID } from '@/lib/ghl';

const GHL_CUSTOM_OBJECT_ID = process.env.GHL_CUSTOM_OBJECT_ID!;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = req.query.id as string;
  if (!id) return res.status(400).json({ error: 'Record ID required' });

  try {
    await ghlRequest<any>({
      method: 'DELETE',
      path: `/objects/${GHL_CUSTOM_OBJECT_ID}/records/${id}`,
      params: { locationId: GHL_LOCATION_ID },
    });

    res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('Activity delete error:', error);
    res.status(500).json({ error: error.message ?? 'Failed to delete activity' });
  }
}
