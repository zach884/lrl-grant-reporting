// lib/ghl/catalogCache.ts — memoized business + contact field catalogs.
// Field definitions rarely change, so we cache them (TTL) to avoid re-fetching two
// catalogs on every webhook. Reload with force=true after a schema change.

import { getBusinessFieldCatalog, getContactFieldCatalog } from './customFields';
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
