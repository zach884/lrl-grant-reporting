// pages/api/activities/list.ts — List/filter activity records from GHL
import type { NextApiRequest, NextApiResponse } from 'next';
import { ghlRequest, GHL_LOCATION_ID } from '@/lib/ghl';

const GHL_CUSTOM_OBJECT_ID = process.env.GHL_CUSTOM_OBJECT_ID!;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const data = await ghlRequest<any>({
      method: 'POST',
      path: `/objects/${GHL_CUSTOM_OBJECT_ID}/records/search`,
      body: {
        locationId: GHL_LOCATION_ID,
        query: '',
        page: 1,
        pageLimit: 100,
        searchAfter: [],
        sort: [{ field: 'updatedAt', direction: 'desc' }],
      },
    });

    const records = data.records ?? data.data ?? [];
    const activities = records.map((r: any) => {
      const props = r.properties ?? r;
      const activityName = props.activity_name ?? '';
      // Extract contact name from activity name format: "Type – Contact – Date Time"
      const nameParts = activityName.split(' – ');
      const contactName = nameParts.length >= 3 ? nameParts[1] : '';
      return {
        id: r.id ?? r._id,
        activity_name: activityName,
        activity_type: props.activity_type ?? '',
        activity_date: props.activity_date ?? '',
        activity_owner: props.activity_owner ?? '',
        activity_notes: props.activity_notes ?? '',
        program__grant_association: props.program__grant_association ?? [],
        referral_type: props.referral_type ?? '',
        contact_name: contactName,
      };
    });

    res.status(200).json({ activities });
  } catch (error: any) {
    console.error('Activity list error:', error);
    res.status(500).json({ error: error.message ?? 'Failed to list activities' });
  }
}
