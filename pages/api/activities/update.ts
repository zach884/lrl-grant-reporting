// pages/api/activities/update.ts — Edit existing activity record
import type { NextApiRequest, NextApiResponse } from 'next';
import { ghlRequest, GHL_LOCATION_ID } from '@/lib/ghl';

const GHL_CUSTOM_OBJECT_ID = process.env.GHL_CUSTOM_OBJECT_ID!;
const NS = 'custom_objects.activities';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PUT') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { id, ...fields } = req.body;
    if (!id) return res.status(400).json({ error: 'Record ID required' });

    const data = await ghlRequest<any>({
      method: 'PUT',
      path: `/objects/${GHL_CUSTOM_OBJECT_ID}/records/${id}`,
      body: {
        locationId: GHL_LOCATION_ID,
        properties: {
          [`${NS}.activity_name`]: fields.activity_name,
          [`${NS}.activity_date`]: fields.activity_date,
          [`${NS}.activity_type`]: fields.activity_type,
          [`${NS}.activity_notes`]: fields.activity_notes ?? '',
          [`${NS}.activity_owner`]: fields.activity_owner,
          [`${NS}.program__grant_association`]: fields.program__grant_association,
          [`${NS}.referral_type`]: fields.referral_type ?? '',
        },
      },
    });

    res.status(200).json({ success: true, record: data });
  } catch (error: any) {
    console.error('Activity update error:', error);
    res.status(500).json({ error: error.message ?? 'Failed to update activity' });
  }
}
