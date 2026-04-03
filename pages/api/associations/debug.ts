// pages/api/associations/debug.ts — Find association IDs by trying path-based lookups
import type { NextApiRequest, NextApiResponse } from 'next';
import { GHL_LOCATION_ID } from '@/lib/ghl';

const GHL_API_KEY = process.env.GHL_API_KEY!;
const GHL_CUSTOM_OBJECT_ID = process.env.GHL_CUSTOM_OBJECT_ID!;
const CONTACT_OBJECT_ID = '691b69a307191a9187aea278';
const GHL_BASE_URL = 'https://services.leadconnectorhq.com';

async function ghlFetch(method: string, path: string, params?: Record<string, string>, body?: any) {
  const url = new URL(`${GHL_BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
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

  // Try GET /associations/entity/{objectId} with the Activities object ID
  results['GET /associations/entity/{activitiesObjectId}'] = await ghlFetch(
    'GET',
    `/associations/entity/${GHL_CUSTOM_OBJECT_ID}`,
    { locationId: GHL_LOCATION_ID }
  );

  // Try with contact object ID
  results['GET /associations/entity/{contactObjectId}'] = await ghlFetch(
    'GET',
    `/associations/entity/${CONTACT_OBJECT_ID}`,
    { locationId: GHL_LOCATION_ID }
  );

  // Try listing all associations for the location with pagination
  results['GET /associations/entity?skip=0&limit=100'] = await ghlFetch(
    'GET',
    '/associations/entity',
    { locationId: GHL_LOCATION_ID, skip: '0', limit: '100' }
  );

  // Try with hasAssociations param
  results['GET /associations/entity?hasAssociations=true'] = await ghlFetch(
    'GET',
    '/associations/entity',
    { locationId: GHL_LOCATION_ID, hasAssociations: 'true', objectId: GHL_CUSTOM_OBJECT_ID }
  );

  // Try getting relations for a known record (the test record we created earlier)
  results['GET /associations/relations/{testRecordId}'] = await ghlFetch(
    'GET',
    '/associations/relations/69d01af6ebc579af8202c50d',
    { locationId: GHL_LOCATION_ID }
  );

  // Try creating a relation without associationId to see what error we get
  results['POST /associations/relations (no assocId)'] = await ghlFetch(
    'POST',
    '/associations/relations',
    undefined,
    {
      locationId: GHL_LOCATION_ID,
      firstRecordId: '69d01af6ebc579af8202c50d',
      secondRecordId: 'GjJQGARB6tRUhHYi9RQm',
    }
  );

  res.status(200).json(results);
}
