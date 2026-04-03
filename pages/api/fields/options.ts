// pages/api/fields/options.ts — Get dropdown options from GHL Custom Object field schema
import type { NextApiRequest, NextApiResponse } from 'next';
import { ghlRequest } from '@/lib/ghl';

const GHL_CUSTOM_OBJECT_ID = process.env.GHL_CUSTOM_OBJECT_ID!;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID!;

// The fields we need, mapped to their short keys used in the app
const FIELD_SHORT_KEYS: Record<string, string> = {
  'custom_objects.activities.activity_type': 'activity_type',
  'custom_objects.activities.referral_type': 'referral_type',
  'custom_objects.activities.program__grant_association': 'program__grant_association',
};

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

    const data = await ghlRequest<any>({
      path: `/objects/${GHL_CUSTOM_OBJECT_ID}`,
      params: { locationId: GHL_LOCATION_ID, fetchProperties: 'true' },
    });

    const fields = data.fields ?? [];

    const result: Record<string, { key: string; label: string }[]> = {};

    for (const field of fields) {
      const fullKey = field.fieldKey ?? '';
      // Match by full namespaced key or short key
      const shortKey = FIELD_SHORT_KEYS[fullKey] || fullKey.split('.').pop() || '';

      if (['activity_type', 'referral_type', 'program__grant_association'].includes(shortKey)) {
        const options = (field.options ?? []).map((opt: any) => ({
          key: opt.key ?? opt.value ?? opt,
          label: opt.label ?? opt.name ?? opt.key ?? opt,
        }));
        result[shortKey] = options;
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
