// lib/wix/catalogCache.ts — 10-min memo of Wix collection lists + schemas.
// Mirrors lib/ghl/catalogCache.ts: the mapper UI + resolver hit these often; the Wix Data
// API is fine but there's no reason to re-fetch a schema on every keystroke.

import { getCollectionSchema, listCollections } from './collections';
import type { WixCollectionSchema, WixCollectionSummary } from './types';

const TTL_MS = 10 * 60 * 1000;

let collectionsCache: { at: number; data: WixCollectionSummary[] } | null = null;
const schemaCache = new Map<string, { at: number; data: WixCollectionSchema }>();

export async function getWixCollections(force = false): Promise<WixCollectionSummary[]> {
  if (!force && collectionsCache && Date.now() - collectionsCache.at < TTL_MS) return collectionsCache.data;
  const data = await listCollections();
  collectionsCache = { at: Date.now(), data };
  return data;
}

export async function getWixCollectionSchema(id: string, force = false): Promise<WixCollectionSchema> {
  const hit = schemaCache.get(id);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const data = await getCollectionSchema(id);
  schemaCache.set(id, { at: Date.now(), data });
  return data;
}
