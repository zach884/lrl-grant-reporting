// pages/api/associations/debug.ts — Debug endpoint to find association definitions
import type { NextApiRequest, NextApiResponse } from 'next';
import { ghlRequest, GHL_LOCATION_ID } from '@/lib/ghl';

const GHL_CUSTOM_OBJECT_ID = process.env.GHL_CUSTOM_OBJECT_ID!;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const results: Record<string, any> = {};

  // Try different ways to get association definitions
  const attempts: { label: string; path: string; params: Record<string, string> }[] = [
    { label: 'GET /associations?objectId', path: '/associations', params: { locationId: GHL_LOCATION_ID, objectId: GHL_CUSTOM_OBJECT_ID } },
    { label: 'GET /associations?locationId', path: '/associations', params: { locationId: GHL_LOCATION_ID } },
    { label: 'GET /objects/{id}/associations', path: `/objects/${GHL_CUSTOM_OBJECT_ID}/associations`, params: { locationId: GHL_LOCATION_ID } },
  ];

  for (const attempt of attempts) {
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

  res.status(200).json(results);
}
