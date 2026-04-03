// pages/api/activities/create.ts — Create GHL Custom Object record
import type { NextApiRequest, NextApiResponse } from 'next';
import { ghlRequest, GHL_LOCATION_ID } from '@/lib/ghl';

const GHL_CUSTOM_OBJECT_ID = process.env.GHL_CUSTOM_OBJECT_ID!;

// Association definition IDs (from GHL)
const ACTIVITY_CONTACT_ASSOC_ID = '69cfd43a7dde13295d11fe26';
const REFERRAL_CONTACT_ASSOC_ID = '69cfe156dd8fc9d773987042';

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

    const finalName = activity_name || `${activity_type} – ${activity_date}`;

    // Step 1: Create the record
    const data = await ghlRequest<any>({
      method: 'POST',
      path: `/objects/${GHL_CUSTOM_OBJECT_ID}/records`,
      body: {
        locationId: GHL_LOCATION_ID,
        properties: {
          activity_name: finalName,
          activity_date,
          activity_type,
          activity_notes: activity_notes || '',
          appointment_id: `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          activity_owner,
          program__grant_association: Array.isArray(program__grant_association)
            ? program__grant_association
            : [program__grant_association],
          referral_type: referral_type
            ? (Array.isArray(referral_type) ? referral_type : [referral_type])
            : [],
        },
      },
    });

    const recordId = data.record?.id ?? data.id;

    // Step 2: Associate primary contact
    if (recordId && contact_id) {
      try {
        await ghlRequest<any>({
          method: 'POST',
          path: '/associations/relations',
          body: {
            locationId: GHL_LOCATION_ID,
            associationId: ACTIVITY_CONTACT_ASSOC_ID,
            firstRecordId: recordId,
            secondRecordId: contact_id,
          },
        });
      } catch (err) {
        console.warn('Failed to associate primary contact:', err);
      }
    }

    // Step 3: Associate referred-to contact (uses different association)
    if (recordId && referred_to_id) {
      try {
        await ghlRequest<any>({
          method: 'POST',
          path: '/associations/relations',
          body: {
            locationId: GHL_LOCATION_ID,
            associationId: REFERRAL_CONTACT_ASSOC_ID,
            firstRecordId: recordId,
            secondRecordId: referred_to_id,
          },
        });
      } catch (err) {
        console.warn('Failed to associate referred-to contact:', err);
      }
    }

    res.status(200).json({ success: true, record: data });
  } catch (error: any) {
    console.error('Activity create error:', error);
    res.status(500).json({ error: error.message ?? 'Failed to create activity' });
  }
}
