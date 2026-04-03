// pages/api/fields/options.ts — Get dropdown options from GHL Custom Object field schema
import type { NextApiRequest, NextApiResponse } from 'next';
import { ghlRequest } from '@/lib/ghl';

const GHL_CUSTOM_OBJECT_ID = process.env.GHL_CUSTOM_OBJECT_ID!;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID!;

// Cache field options for 10 minutes
let cache: any = null;
let cacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (cache && Date.now() - cacheTime < CACHE_TTL && req.query.refresh !== 'true') {
      return res.status(200).json(cache);
    }

    // Fetch custom object schema to get field definitions and dropdown options
    const data = await ghlRequest<any>({
      path: `/objects/${GHL_CUSTOM_OBJECT_ID}/fields`,
      params: { locationId: GHL_LOCATION_ID },
    });

    const fields = data.fields ?? data.customFields ?? [];

    // Extract dropdown options for the fields we need
    const result: Record<string, { key: string; label: string }[]> = {};

    for (const field of fields) {
      const key = field.fieldKey ?? field.key ?? '';
      if (['activity_type', 'referral_type', 'program__grant_association'].includes(key)) {
        const options = (field.options ?? field.picklistOptions ?? []).map((opt: any) => ({
          key: typeof opt === 'string' ? opt : opt.value ?? opt.key ?? opt,
          label: typeof opt === 'string' ? opt : opt.label ?? opt.name ?? opt.value ?? opt,
        }));
        result[key] = options;
      }
    }

    cache = result;
    cacheTime = Date.now();

    res.status(200).json(result);
  } catch (error: any) {
    console.error('Field options error:', error);
    res.status(500).json({ error: error.message ?? 'Failed to fetch field options' });
  }
}
