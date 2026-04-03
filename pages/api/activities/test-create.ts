// pages/api/activities/test-create.ts — Debug endpoint to test GHL record creation formats
import type { NextApiRequest, NextApiResponse } from 'next';
import { ghlRequest, GHL_LOCATION_ID } from '@/lib/ghl';

const GHL_CUSTOM_OBJECT_ID = process.env.GHL_CUSTOM_OBJECT_ID!;
const NS = 'custom_objects.activities';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const results: Record<string, any> = {};

  const testName = `Test Activity – ${new Date().toISOString()}`;

  // Format 1: properties with namespaced keys
  try {
    const data = await ghlRequest<any>({
      method: 'POST',
      path: `/objects/${GHL_CUSTOM_OBJECT_ID}/records`,
      body: {
        locationId: GHL_LOCATION_ID,
        properties: {
          [`${NS}.activity_name`]: testName,
          [`${NS}.activity_type`]: 'intake',
        },
      },
    });
    results['format1_properties_namespaced'] = { success: true, data };
  } catch (e: any) {
    results['format1_properties_namespaced'] = { success: false, error: e.message };
  }

  // Format 2: properties with short keys
  try {
    const data = await ghlRequest<any>({
      method: 'POST',
      path: `/objects/${GHL_CUSTOM_OBJECT_ID}/records`,
      body: {
        locationId: GHL_LOCATION_ID,
        properties: {
          activity_name: testName + ' (short)',
          activity_type: 'intake',
        },
      },
    });
    results['format2_properties_short'] = { success: true, data };
  } catch (e: any) {
    results['format2_properties_short'] = { success: false, error: e.message };
  }

  // Format 3: flat at top level with namespaced keys
  try {
    const data = await ghlRequest<any>({
      method: 'POST',
      path: `/objects/${GHL_CUSTOM_OBJECT_ID}/records`,
      body: {
        locationId: GHL_LOCATION_ID,
        [`${NS}.activity_name`]: testName + ' (flat ns)',
        [`${NS}.activity_type`]: 'intake',
      },
    });
    results['format3_flat_namespaced'] = { success: true, data };
  } catch (e: any) {
    results['format3_flat_namespaced'] = { success: false, error: e.message };
  }

  // Format 4: flat at top level with short keys
  try {
    const data = await ghlRequest<any>({
      method: 'POST',
      path: `/objects/${GHL_CUSTOM_OBJECT_ID}/records`,
      body: {
        locationId: GHL_LOCATION_ID,
        activity_name: testName + ' (flat short)',
        activity_type: 'intake',
      },
    });
    results['format4_flat_short'] = { success: true, data };
  } catch (e: any) {
    results['format4_flat_short'] = { success: false, error: e.message };
  }

  res.status(200).json(results);
}
