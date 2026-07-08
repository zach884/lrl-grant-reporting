// lib/ghl/index.ts — public surface of the GHL data-access layer.
//
// New code should import the typed helpers (businesses/contacts/customFields/...).
// The `ghlRequest` + `GHL_LOCATION_ID` exports preserve the original thin-wrapper API
// so the existing pages/api/* routes keep working unchanged.

export * from './types';
export * from './errors';
export * from './config';
export { GhlClient, ghl, resetDefaultClient } from './client';
export type { GhlRequestOptions } from './client';
export * from './coerce';
export * as customFields from './customFields';
export * as businesses from './businesses';
export * as contacts from './contacts';
export * as associations from './associations';

import { ghl, GhlRequestOptions } from './client';

/**
 * Back-compat shim for the original client. Prefer the typed resource helpers in new code.
 * Auto-injects locationId only when the caller didn't supply it (routes usually do).
 */
export async function ghlRequest<T = any>(opts: {
  method?: string;
  path: string;
  params?: Record<string, string>;
  body?: unknown;
}): Promise<T> {
  const options: GhlRequestOptions = {
    method: opts.method,
    path: opts.path,
    params: opts.params,
    body: opts.body,
  };
  return ghl().request<T>(options);
}

/** Back-compat: the live location id, as the original module exported it. */
export const GHL_LOCATION_ID: string = process.env.GHL_LOCATION_ID ?? '';
