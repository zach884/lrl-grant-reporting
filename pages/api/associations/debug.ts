// pages/api/associations/debug.ts — Try different API versions for associations
import type { NextApiRequest, NextApiResponse } from 'next';
import { GHL_LOCATION_ID } from '@/lib/ghl';

const GHL_API_KEY = process.env.GHL_API_KEY!;
const GHL_CUSTOM_OBJECT_ID = process.env.GHL_CUSTOM_OBJECT_ID!;
const GHL_BASE_URL = 'https://services.leadconnectorhq.com';

async function ghlFetch(path: string, version: string, params?: Record<string, string>) {
  const url = new URL(`${GHL_BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      Version: version,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text };
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const results: Record<string, any> = {};

  // Try listing associations with different API versions
  const versions = ['2021-07-28', '2021-04-15', '2023-01-01', '2024-01-01'];
  const paths: { path: string; params: Record<string, string> }[] = [
    { path: '/associations/entity', params: { locationId: GHL_LOCATION_ID, objectKey: 'custom_objects.activities' } },
    { path: '/associations/entity', params: { locationId: GHL_LOCATION_ID, objectId: GHL_CUSTOM_OBJECT_ID } },
  ];

  for (const version of versions) {
    for (const p of paths) {
      const label = `${version} | GET ${p.path}?${Object.entries(p.params).filter(([k]) => k !== 'locationId').map(([k, v]) => `${k}=${v}`).join('&')}`;
      results[label] = await ghlFetch(p.path, version, p.params);
    }
  }

  res.status(200).json(results);
}
