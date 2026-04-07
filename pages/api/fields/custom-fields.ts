// pages/api/fields/custom-fields.ts — List all GHL contact custom fields with their IDs
import type { NextApiRequest, NextApiResponse } from 'next';
import { ghlRequest, GHL_LOCATION_ID } from '@/lib/ghl';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    // Try multiple endpoints to find custom field definitions
    let data: any;
    const attempts = [
      `/locations/${GHL_LOCATION_ID}/customFields`,
      '/locations/customFields',
      '/custom-fields',
      '/customFields',
      '/locations/custom-fields',
    ];

    let lastError = '';
    for (const path of attempts) {
      try {
        data = await ghlRequest<any>({
          path,
          params: { locationId: GHL_LOCATION_ID },
        });
        break;
      } catch (e: any) {
        lastError = e.message;
      }
    }

    if (!data) {
      return res.status(500).json({ error: `All endpoints failed. Last: ${lastError}` });
    }

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
