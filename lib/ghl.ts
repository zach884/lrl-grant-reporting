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

// Cache for custom field definitions: maps human-readable key → internal ID
let customFieldKeyToId: Record<string, string> | null = null;
let customFieldIdToKey: Record<string, string> | null = null;
let cfCacheTime = 0;
const CF_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

export async function getCustomFieldMaps(): Promise<{
  keyToId: Record<string, string>;
  idToKey: Record<string, string>;
}> {
  if (customFieldKeyToId && customFieldIdToKey && Date.now() - cfCacheTime < CF_CACHE_TTL) {
    return { keyToId: customFieldKeyToId, idToKey: customFieldIdToKey };
  }

  const data = await ghlRequest<any>({
    path: '/locations/custom-fields',
    params: { locationId: GHL_LOCATION_ID },
  });

  const fields = data.customFields ?? data.fields ?? [];
  const keyToId: Record<string, string> = {};
  const idToKey: Record<string, string> = {};

  for (const f of fields) {
    const id = f.id ?? '';
    const key = f.fieldKey ?? f.key ?? '';
    if (id && key) {
      keyToId[key] = id;
      idToKey[id] = key;
      // Also map by short key (last segment after dot)
      if (key.includes('.')) {
        const shortKey = key.split('.').pop()!;
        keyToId[shortKey] = id;
        idToKey[id] = shortKey;
      }
    }
  }

  customFieldKeyToId = keyToId;
  customFieldIdToKey = idToKey;
  cfCacheTime = Date.now();

  return { keyToId, idToKey };
}
