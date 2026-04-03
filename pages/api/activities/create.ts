// pages/api/activities/create.ts — Create GHL Custom Object record
import type { NextApiRequest, NextApiResponse } from 'next';
import { ghlRequest, GHL_LOCATION_ID } from '@/lib/ghl';

const GHL_CUSTOM_OBJECT_ID = process.env.GHL_CUSTOM_OBJECT_ID!;
const NS = 'custom_objects.activities';

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

    // Ensure activity_name is not empty (required by GHL)
    const finalName = activity_name || `${activity_type} – ${activity_date}`;

    console.log('Creating activity:', { activity_name, finalName, activity_type, activity_date });

    // Step 1: Create the record (no associations inline — GHL rejects them)
    const data = await ghlRequest<any>({
      method: 'POST',
      path: `/objects/${GHL_CUSTOM_OBJECT_ID}/records`,
      body: {
        locationId: GHL_LOCATION_ID,
        properties: {
          [`${NS}.activity_name`]: finalName,
          [`${NS}.activity_date`]: activity_date,
          [`${NS}.activity_type`]: activity_type,
          [`${NS}.activity_notes`]: activity_notes || '',
          [`${NS}.appointment_id`]: '',
          [`${NS}.activity_owner`]: activity_owner,
          [`${NS}.program__grant_association`]: Array.isArray(program__grant_association)
            ? program__grant_association
            : [program__grant_association],
          [`${NS}.referral_type`]: referral_type || '',
        },
      },
    });

    const recordId = data.record?.id ?? data.id;

    // Step 2: Create associations separately via the associations API
    if (recordId && contact_id) {
      try {
        await createAssociation(recordId, contact_id);
      } catch (err) {
        console.warn('Failed to associate primary contact:', err);
      }
    }

    if (recordId && referred_to_id) {
      try {
        await createAssociation(recordId, referred_to_id);
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

async function createAssociation(recordId: string, contactId: string) {
  // First, find the association definition between activities and contacts
  // Then create the relation
  try {
    // Get associations for this object
    const assocDefs = await ghlRequest<any>({
      path: `/associations`,
      params: {
        locationId: GHL_LOCATION_ID,
        objectId: GHL_CUSTOM_OBJECT_ID,
      },
    });

    const associations = assocDefs.associations ?? assocDefs.data ?? [];
    // Find the contact association
    const contactAssoc = associations.find(
      (a: any) =>
        a.firstObjectKey === 'contact' ||
        a.secondObjectKey === 'contact' ||
        a.firstObjectId === '691b69a307191a9187aea278' ||
        a.secondObjectId === '691b69a307191a9187aea278'
    );

    if (!contactAssoc) {
      console.warn('No contact association definition found');
      return;
    }

    await ghlRequest<any>({
      method: 'POST',
      path: `/associations/relations`,
      body: {
        locationId: GHL_LOCATION_ID,
        associationId: contactAssoc.id,
        firstRecordId: recordId,
        secondRecordId: contactId,
      },
    });
  } catch (err) {
    console.warn('Association creation failed:', err);
  }
}
