// pages/api/activities/create.ts — Create GHL Custom Object record
import type { NextApiRequest, NextApiResponse } from 'next';
import { ghlRequest, GHL_LOCATION_ID } from '@/lib/ghl';

const GHL_CUSTOM_OBJECT_ID = process.env.GHL_CUSTOM_OBJECT_ID!;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      contact_id,
      activity_name,
      activity_date,
      activity_type,
      activity_notes,
      activity_owner,
      program__grant_association,
      referral_type,
      referred_to_id,
    } = req.body;

    // Build associations
    const associations: any[] = [
      { objectKey: 'contact', recordId: contact_id },
    ];
    if (referred_to_id) {
      associations.push({ objectKey: 'contact', recordId: referred_to_id });
    }

    // GHL custom object fields use namespaced keys
    const ns = 'custom_objects.activities';

    // Create the record
    const data = await ghlRequest<any>({
      method: 'POST',
      path: `/objects/${GHL_CUSTOM_OBJECT_ID}/records`,
      body: {
        locationId: GHL_LOCATION_ID,
        properties: {
          [`${ns}.activity_name`]: activity_name,
          [`${ns}.activity_date`]: activity_date,
          [`${ns}.activity_type`]: activity_type,
          [`${ns}.activity_notes`]: activity_notes || '',
          [`${ns}.appointment_id`]: '',
          [`${ns}.activity_owner`]: activity_owner,
          [`${ns}.program__grant_association`]: Array.isArray(program__grant_association)
            ? program__grant_association
            : [program__grant_association],
          [`${ns}.referral_type`]: referral_type || '',
        },
        associations,
      },
    });

    res.status(200).json({ success: true, record: data });
  } catch (error: any) {
    console.error('Activity create error:', error);
    res.status(500).json({ error: error.message ?? 'Failed to create activity' });
  }
}
