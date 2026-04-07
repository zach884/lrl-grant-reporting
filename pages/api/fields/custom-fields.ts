// pages/api/fields/custom-fields.ts — List all GHL contact custom fields with their IDs
import type { NextApiRequest, NextApiResponse } from 'next';
import { ghlRequest, GHL_LOCATION_ID } from '@/lib/ghl';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const data = await ghlRequest<any>({
      path: '/locations/custom-fields',
      params: { locationId: GHL_LOCATION_ID },
    });

    const fields = (data.customFields ?? data.fields ?? []).map((f: any) => ({
      id: f.id,
      name: f.name,
      fieldKey: f.fieldKey ?? f.key,
      dataType: f.dataType,
    }));

    res.status(200).json({ fields });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}
