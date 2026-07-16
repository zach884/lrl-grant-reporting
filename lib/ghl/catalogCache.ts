// lib/ghl/catalogCache.ts — memoized business + contact field catalogs.
// Field definitions rarely change, so we cache them (TTL) to avoid re-fetching two
// catalogs on every webhook. Reload with force=true after a schema change.

import { getBusinessFieldCatalog, getContactFieldCatalog, getFieldCatalog } from './customFields';
import { GhlClient } from './client';
import { CustomFieldCatalog } from './types';

export interface Catalogs {
  business: CustomFieldCatalog;
  contact: CustomFieldCatalog;
}

const TTL_MS = 10 * 60 * 1000;
let cache: (Catalogs & { at: number }) | null = null;

export async function getCatalogs(opts: { force?: boolean; client?: GhlClient } = {}): Promise<Catalogs> {
  if (!opts.force && cache && Date.now() - cache.at < TTL_MS) {
    return { business: cache.business, contact: cache.contact };
  }
  const [business, contact] = await Promise.all([
    getBusinessFieldCatalog(opts.client),
    getContactFieldCatalog(opts.client),
  ]);
  cache = { business, contact, at: Date.now() };
  return { business, contact };
}

// Per-object catalog cache (contact/business/opportunity/custom_objects.*), for the
// object-agnostic mapper. Keyed by objectKey; 10-min TTL.
const objCache = new Map<string, { at: number; catalog: CustomFieldCatalog }>();

export async function getCatalog(objectKey: string, opts: { force?: boolean; client?: GhlClient } = {}): Promise<CustomFieldCatalog> {
  const hit = objCache.get(objectKey);
  if (!opts.force && hit && Date.now() - hit.at < TTL_MS) return hit.catalog;
  const catalog = await getFieldCatalog(objectKey, opts.client);
  objCache.set(objectKey, { at: Date.now(), catalog });
  return catalog;
}
