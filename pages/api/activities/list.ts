// pages/api/activities/list.ts — List/filter activity records from GHL
import type { NextApiRequest, NextApiResponse } from 'next';
import { ghlRequest, GHL_LOCATION_ID } from '@/lib/ghl';

const GHL_CUSTOM_OBJECT_ID = process.env.GHL_CUSTOM_OBJECT_ID!;
const NS = 'custom_objects.activities';

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
        searchFilters: [],
        sort: { field: `${NS}.activity_date`, direction: 'desc' },
      },
    });

    const records = data.records ?? data.data ?? [];
    const activities = records.map((r: any) => {
      const props = r.properties ?? r;
      // GHL returns namespaced keys — extract using both formats
      const get = (key: string) => props[`${NS}.${key}`] ?? props[key] ?? '';
      return {
        id: r.id ?? r._id,
        activity_name: get('activity_name'),
        activity_type: get('activity_type'),
        activity_date: get('activity_date'),
        activity_owner: get('activity_owner'),
        activity_notes: get('activity_notes'),
        program__grant_association: get('program__grant_association') || [],
        referral_type: get('referral_type'),
        contact_name: '',
      };
    });

    res.status(200).json({ activities });
  } catch (error: any) {
    console.error('Activity list error:', error);
    res.status(500).json({ error: error.message ?? 'Failed to list activities' });
  }
}
