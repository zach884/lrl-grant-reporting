// pages/api/fields/debug.ts — Debug endpoint to discover GHL custom object schema shape
import type { NextApiRequest, NextApiResponse } from 'next';
import { ghlRequest } from '@/lib/ghl';

const GHL_CUSTOM_OBJECT_ID = process.env.GHL_CUSTOM_OBJECT_ID!;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID!;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const results: Record<string, any> = {};

  // Try multiple possible endpoints to find which one works
  const attempts: { label: string; path: string; params: Record<string, string> }[] = [
    { label: 'GET /objects/{id}?fetchProperties=true', path: `/objects/${GHL_CUSTOM_OBJECT_ID}`, params: { locationId: GHL_LOCATION_ID, fetchProperties: 'true' } },
    { label: 'GET /objects/{id}/fields', path: `/objects/${GHL_CUSTOM_OBJECT_ID}/fields`, params: { locationId: GHL_LOCATION_ID } },
    { label: 'GET /objects/?locationId', path: `/objects/`, params: { locationId: GHL_LOCATION_ID } },
  ];

  for (const attempt of attempts) {
    try {
      const data = await ghlRequest<any>({
        path: attempt.path,
        params: attempt.params,
      });
      results[attempt.label] = { success: true, keys: Object.keys(data), data };
    } catch (error: any) {
      results[attempt.label] = { success: false, error: error.message };
    }
  }

  res.status(200).json(results);
}
