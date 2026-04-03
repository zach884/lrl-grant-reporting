// pages/api/associations/test-create.ts — Test creating a single association
import type { NextApiRequest, NextApiResponse } from 'next';
import { GHL_LOCATION_ID } from '@/lib/ghl';

const GHL_API_KEY = process.env.GHL_API_KEY!;
const GHL_BASE_URL = 'https://services.leadconnectorhq.com';

const ACTIVITY_CONTACT_ASSOC_ID = '69cfd43a7dde13295d11fe26';
const REFERRAL_CONTACT_ASSOC_ID = '69cfe156dd8fc9d773987042';
const TEST_CONTACT_ID = 'GjJQGARB6tRUhHYi9RQm';
// Use one of the activity records we already created
const TEST_RECORD_ID = '69d01af6ebc579af8202c50d';

async function ghlFetch(method: string, path: string, body?: any) {
  const url = `${GHL_BASE_URL}${path}`;
  const res = await fetch(url, {
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

  // Try Activity Contact association with different field orderings
  const attempts = [
    {
      label: 'activity-first contact-second',
      body: {
        locationId: GHL_LOCATION_ID,
        associationId: ACTIVITY_CONTACT_ASSOC_ID,
        firstRecordId: TEST_RECORD_ID,
        secondRecordId: TEST_CONTACT_ID,
      },
    },
    {
      label: 'contact-first activity-second',
      body: {
        locationId: GHL_LOCATION_ID,
        associationId: ACTIVITY_CONTACT_ASSOC_ID,
        firstRecordId: TEST_CONTACT_ID,
        secondRecordId: TEST_RECORD_ID,
      },
    },
    {
      label: 'referral assoc: activity-first contact-second',
      body: {
        locationId: GHL_LOCATION_ID,
        associationId: REFERRAL_CONTACT_ASSOC_ID,
        firstRecordId: TEST_RECORD_ID,
        secondRecordId: TEST_CONTACT_ID,
      },
    },
  ];

  for (const attempt of attempts) {
    results[attempt.label] = await ghlFetch('POST', '/associations/relations', attempt.body);
    // If it succeeded, don't try more
    if (results[attempt.label].status === 200 || results[attempt.label].status === 201) break;
  }

  // Also check existing relations on the test record
  results['existing relations'] = await ghlFetch(
    'GET',
    `/associations/relations/record/${TEST_RECORD_ID}?locationId=${GHL_LOCATION_ID}&associationIds=${ACTIVITY_CONTACT_ASSOC_ID},${REFERRAL_CONTACT_ASSOC_ID}&skip=0&limit=5`
  );

  res.status(200).json(results);
}
