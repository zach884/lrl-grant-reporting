// lib/ghl.ts — GHL API client

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const GHL_API_KEY = process.env.GHL_API_KEY!;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID!;
const GHL_API_VERSION = '2021-07-28';

interface GHLRequestOptions {
  method?: string;
  path: string;
  params?: Record<string, string>;
  body?: unknown;
}

export async function ghlRequest<T = any>(opts: GHLRequestOptions): Promise<T> {
  const url = new URL(`${GHL_BASE_URL}${opts.path}`);
  if (opts.params) {
    for (const [key, value] of Object.entries(opts.params)) {
      url.searchParams.set(key, value);
    }
  }

  const res = await fetch(url.toString(), {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      Version: GHL_API_VERSION,
      'Content-Type': 'application/json',
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL API ${res.status}: ${text}`);
  }

  return res.json();
}

export { GHL_LOCATION_ID };
