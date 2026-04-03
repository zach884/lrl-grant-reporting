// pages/api/associations/debug.ts — Find association IDs
import type { NextApiRequest, NextApiResponse } from 'next';
import { ghlRequest, GHL_LOCATION_ID } from '@/lib/ghl';

const GHL_CUSTOM_OBJECT_ID = process.env.GHL_CUSTOM_OBJECT_ID!;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const results: Record<string, any> = {};

  // The object schema endpoint showed associations info when we fetched it before
  // Let's get the full object and look for association IDs
  try {
    const data = await ghlRequest<any>({
      path: `/objects/${GHL_CUSTOM_OBJECT_ID}`,
      params: { locationId: GHL_LOCATION_ID, fetchProperties: 'true' },
    });
    // Look for any association-related keys in the response
    const obj = data.object ?? {};
    results['object_keys'] = Object.keys(obj);
    results['object_associations'] = obj.associations ?? obj.relations ?? 'not in object';
    results['full_object'] = obj;
  } catch (e: any) {
    results['object_fetch'] = { error: e.message };
  }

  // Try listing associations for the location
  const paths: { label: string; path: string; params: Record<string, string> }[] = [
    { label: 'GET /associations/entity (no objectId)', path: '/associations/entity', params: { locationId: GHL_LOCATION_ID } },
    { label: 'GET /associations (locationId only)', path: '/associations', params: { locationId: GHL_LOCATION_ID } },
    { label: 'GET /associations/entity?objectKey', path: '/associations/entity', params: { locationId: GHL_LOCATION_ID, objectKey: 'custom_objects.activities' } },
    { label: 'GET /associations?objectKey', path: '/associations', params: { locationId: GHL_LOCATION_ID, objectKey: 'custom_objects.activities' } },
    { label: 'POST /associations/entity/search', path: '/associations/entity/search', params: { locationId: GHL_LOCATION_ID } },
  ];

  for (const attempt of paths) {
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

  // Try POST search for associations
  try {
    const data = await ghlRequest<any>({
      method: 'POST',
      path: '/associations/entity/search',
      body: { locationId: GHL_LOCATION_ID, objectId: GHL_CUSTOM_OBJECT_ID },
    });
    results['POST search'] = { success: true, data };
  } catch (e: any) {
    results['POST search'] = { success: false, error: e.message };
  }

  res.status(200).json(results);
}
