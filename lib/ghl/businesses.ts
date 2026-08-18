// lib/ghl/businesses.ts — company (`business`) operations.
//
// Two endpoint families, each with its own quirks (confirmed live):
//   - Legacy /businesses/*  : list (paginate skip), create, rename, delete. Writes
//     STANDARD fields only (name, address...) — CANNOT write custom fields.
//   - Objects /objects/business/records/{id} : read + write CUSTOM field values
//     (properties use BARE keys; locationId query-only).
// Contact<->company link is the contact scalar `businessId` (NOT companyId).

import { GhlClient, ghl } from './client';
import { BusinessListItem, BusinessRecord, CustomFieldDef } from './types';
import { coerceBusinessProperties, CoerceResult } from './coerce';
import { applyObjectWrite } from './objectWrite';

const PAGE = 100;

/** Enumerate ALL companies via legacy list (id + name + postalCode + legacy customFields). */
export async function listAllBusinesses(client: GhlClient = ghl()): Promise<BusinessListItem[]> {
  const out: BusinessListItem[] = [];
  let skip = 0;
  for (;;) {
    const data = await client.request<any>({
      path: '/businesses/',
      params: { limit: PAGE, skip },
    });
    const batch: any[] = data.businesses ?? [];
    if (batch.length === 0) break;
    for (const b of batch) {
      out.push({
        id: b.id,
        name: b.name,
        postalCode: b.postalCode,
        customFields: b.customFields,
      });
    }
    if (batch.length < PAGE) break;
    skip += PAGE;
  }
  return out;
}

/** Read a company's CUSTOM field values (objects API). properties keyed by BARE key. */
export async function getBusinessRecord(
  businessId: string,
  client: GhlClient = ghl(),
): Promise<BusinessRecord | null> {
  const data = await client.request<any>({
    path: `/objects/business/records/${businessId}`,
  });
  const r = data.record ?? data;
  if (!r || !r.id) return null;
  return {
    id: r.id,
    locationId: r.locationId,
    objectKey: r.objectKey,
    properties: r.properties ?? {},
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Create a company (standard fields only). Returns the new id. */
export async function createBusiness(
  name: string,
  extra: Record<string, unknown> = {},
  client: GhlClient = ghl(),
): Promise<string> {
  const data = await client.request<any>({
    method: 'POST',
    path: '/businesses/',
    autoLocation: false,
    body: { name, locationId: client.locationId, ...extra },
  });
  return data.business?.id ?? data.id;
}

/**
 * Create a company via the OBJECTS endpoint with custom-field values coerced in
 * 'create' mode. This is the ONLY path that can set MULTIPLE_OPTIONS fields
 * (confirmed live: settable at create, immutable on update). Use it for the intake
 * create-point and any programmatic company creation that needs multi-selects.
 * Returns { id, coerced } so callers can log skipped fields.
 */
export async function createBusinessRecord(
  values: Record<string, unknown>,
  catalogByKey: Record<string, CustomFieldDef>,
  client: GhlClient = ghl(),
): Promise<{ id: string; coerced: CoerceResult }> {
  const coerced = coerceBusinessProperties(values, catalogByKey, 'create');
  const data = await client.request<any>({
    method: 'POST',
    path: '/objects/business/records',
    autoLocation: false,
    body: { locationId: client.locationId, properties: coerced.properties },
  });
  const id = data.record?.id ?? data.id;
  return { id, coerced };
}

/** Rename a company. PUT /businesses/{id} body {name} ONLY (locationId in body => 422). */
export async function renameBusiness(
  businessId: string,
  name: string,
  client: GhlClient = ghl(),
): Promise<void> {
  await client.request({
    method: 'PUT',
    path: `/businesses/${businessId}`,
    autoLocation: false,
    body: { name },
  });
}

export async function deleteBusiness(businessId: string, client: GhlClient = ghl()): Promise<void> {
  await client.request({ method: 'DELETE', path: `/businesses/${businessId}`, autoLocation: false });
}

/**
 * Write CUSTOM field values to a company, applying all coercion rules.
 * Pass the business field catalog (byKey) so single-selects/dates/numbers coerce
 * correctly. Returns the coercion result (incl. skipped fields) for logging.
 */
export async function setBusinessFields(
  businessId: string,
  values: Record<string, unknown>,
  catalogByKey: Record<string, CustomFieldDef>,
  client: GhlClient = ghl(),
  rawKeys: ReadonlySet<string> = new Set(),
): Promise<CoerceResult> {
  const coerced = coerceBusinessProperties(values, catalogByKey, 'update', rawKeys);
  // Goes through applyObjectWrite so company multi-selects (i_am_selling & co) get the same
  // add/remove diff + read-back verification as every other object write. Fields GHL accepted
  // but didn't store come back as `skipped`, so callers never log them as applied.
  const report = await applyObjectWrite('business', businessId, coerced, catalogByKey, client);
  // report.skipped already carries coerced.skipped forward, so it is the complete list. Callers
  // report the offending value, which may have come in under either the bare or prefixed key.
  return {
    ...coerced,
    skipped: report.skipped.map((r) => ({
      key: r.key,
      value: values[r.key] ?? values[`business.${r.key}`],
      reason: r.reason,
    })),
  };
}
