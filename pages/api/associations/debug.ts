// pages/api/associations/debug.ts — Debug endpoint to find association definitions
import type { NextApiRequest, NextApiResponse } from 'next';
import { ghlRequest, GHL_LOCATION_ID } from '@/lib/ghl';

const GHL_CUSTOM_OBJECT_ID = process.env.GHL_CUSTOM_OBJECT_ID!;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const results: Record<string, any> = {};

  const attempts: { label: string; method?: string; path: string; params?: Record<string, string>; body?: any }[] = [
    // List association definitions
    { label: 'GET /associations', path: '/associations', params: { locationId: GHL_LOCATION_ID, objectId: GHL_CUSTOM_OBJECT_ID } },
    { label: 'GET /associations/object', path: `/associations/${GHL_CUSTOM_OBJECT_ID}`, params: { locationId: GHL_LOCATION_ID } },
    { label: 'GET /associations?query', path: '/associations', params: { locationId: GHL_LOCATION_ID, query: 'contact' } },
    // Try the object schema - it might include association info
    { label: 'GET /objects/{id} full', path: `/objects/${GHL_CUSTOM_OBJECT_ID}`, params: { locationId: GHL_LOCATION_ID, fetchProperties: 'true', fetchAssociations: 'true' } },
    // Try creating a record WITH associations in different formats
    {
      label: 'POST record with associations array',
      method: 'POST',
      path: `/objects/${GHL_CUSTOM_OBJECT_ID}/records`,
      body: {
        locationId: GHL_LOCATION_ID,
        properties: { activity_name: 'Assoc Test 1' },
        associations: [{ objectKey: 'contact', recordId: 'GjJQGARB6tRUhHYi9RQm' }],
      },
    },
    {
      label: 'POST record with association (singular)',
      method: 'POST',
      path: `/objects/${GHL_CUSTOM_OBJECT_ID}/records`,
      body: {
        locationId: GHL_LOCATION_ID,
        properties: { activity_name: 'Assoc Test 2' },
        association: { objectKey: 'contact', recordId: 'GjJQGARB6tRUhHYi9RQm' },
      },
    },
    {
      label: 'POST record with contactId',
      method: 'POST',
      path: `/objects/${GHL_CUSTOM_OBJECT_ID}/records`,
      body: {
        locationId: GHL_LOCATION_ID,
        properties: { activity_name: 'Assoc Test 3' },
        contactId: 'GjJQGARB6tRUhHYi9RQm',
      },
    },
  ];

  for (const attempt of attempts) {
    try {
      const data = await ghlRequest<any>({
        method: attempt.method ?? 'GET',
        path: attempt.path,
        params: attempt.params,
        body: attempt.body,
      });
      results[attempt.label] = { success: true, keys: Object.keys(data), data };
    } catch (e: any) {
      results[attempt.label] = { success: false, error: e.message };
    }
  }

  res.status(200).json(results);
}
