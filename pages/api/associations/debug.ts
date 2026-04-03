// pages/api/associations/debug.ts — Debug endpoint to find and test associations
import type { NextApiRequest, NextApiResponse } from 'next';
import { ghlRequest, GHL_LOCATION_ID } from '@/lib/ghl';

const GHL_CUSTOM_OBJECT_ID = process.env.GHL_CUSTOM_OBJECT_ID!;
// Test contact ID from earlier search
const TEST_CONTACT_ID = 'GjJQGARB6tRUhHYi9RQm';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const results: Record<string, any> = {};

  // Step 1: Find association definitions
  const listPaths: { label: string; path: string; params: Record<string, string> }[] = [
    { label: 'GET /associations/entity', path: '/associations/entity', params: { locationId: GHL_LOCATION_ID, objectId: GHL_CUSTOM_OBJECT_ID } },
    { label: 'GET /associations/entity/schema', path: '/associations/entity/schema', params: { locationId: GHL_LOCATION_ID, objectId: GHL_CUSTOM_OBJECT_ID } },
    { label: 'GET /associations/definitions', path: '/associations/definitions', params: { locationId: GHL_LOCATION_ID } },
    { label: 'GET /objects/associations', path: '/objects/associations', params: { locationId: GHL_LOCATION_ID, objectId: GHL_CUSTOM_OBJECT_ID } },
    { label: 'POST /associations/search', path: '/associations/search', params: { locationId: GHL_LOCATION_ID } },
  ];

  for (const attempt of listPaths) {
    try {
      const data = await ghlRequest<any>({
        path: attempt.path,
        params: attempt.params,
      });
      results[attempt.label] = { success: true, data };
    } catch (e: any) {
      results[attempt.label] = { success: false, error: e.message };
    }
  }

  // Step 2: Try creating an association directly if we find definitions
  // First create a test record
  let testRecordId: string | null = null;
  try {
    const rec = await ghlRequest<any>({
      method: 'POST',
      path: `/objects/${GHL_CUSTOM_OBJECT_ID}/records`,
      body: {
        locationId: GHL_LOCATION_ID,
        properties: { activity_name: 'Association Test Record' },
      },
    });
    testRecordId = rec.record?.id;
    results['test_record_created'] = { success: true, recordId: testRecordId };
  } catch (e: any) {
    results['test_record_created'] = { success: false, error: e.message };
  }

  if (testRecordId) {
    // Try different relation creation formats
    const relationPaths: { label: string; path: string; body: any }[] = [
      {
        label: 'POST /associations/relations (objectKey)',
        path: '/associations/relations',
        body: {
          locationId: GHL_LOCATION_ID,
          firstObjectKey: 'custom_objects.activities',
          firstRecordId: testRecordId,
          secondObjectKey: 'contact',
          secondRecordId: TEST_CONTACT_ID,
        },
      },
      {
        label: 'POST /associations/entity/relation',
        path: '/associations/entity/relation',
        body: {
          locationId: GHL_LOCATION_ID,
          firstObjectId: GHL_CUSTOM_OBJECT_ID,
          firstRecordId: testRecordId,
          secondObjectId: '691b69a307191a9187aea278',
          secondRecordId: TEST_CONTACT_ID,
        },
      },
      {
        label: 'POST /objects/{id}/records/{rid}/associations',
        path: `/objects/${GHL_CUSTOM_OBJECT_ID}/records/${testRecordId}/associations`,
        body: {
          locationId: GHL_LOCATION_ID,
          objectKey: 'contact',
          recordId: TEST_CONTACT_ID,
        },
      },
    ];

    for (const attempt of relationPaths) {
      try {
        const data = await ghlRequest<any>({
          method: 'POST',
          path: attempt.path,
          body: attempt.body,
        });
        results[attempt.label] = { success: true, data };
      } catch (e: any) {
        results[attempt.label] = { success: false, error: e.message };
      }
    }
  }

  res.status(200).json(results);
}
