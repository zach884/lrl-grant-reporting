// lib/ghl/records.ts — object-agnostic READ of a GHL record's fields, keyed by fieldKey.
//
// Two families:
//   - Objects API (business, opportunity, custom_objects.*): GET /objects/{key}/records/{id}
//     -> record.properties is a { bareKey: value } map. We expose values under BOTH the bare
//     key and the prefixed fieldKey ("{objectKey}.{bareKey}") so lookups work either way.
//   - Contact: GET /contacts/{id} -> customFields [{id,value}] keyed by field id (mapped to
//     fieldKey via the catalog) + top-level standard scalars.
// Read-only (no writer this increment). Values are returned in stored form; the dry-run engine
// applies coercion/labels using the catalogs.

import { GhlClient, ghl } from './client';
import { getContact } from './contacts';
import { getCatalog } from './catalogCache';

const CONTACT_SCALAR_KEYS = ['companyName', 'firstName', 'lastName', 'email', 'phone', 'address1', 'city', 'state', 'postalCode', 'country', 'website'] as const;

export interface RecordFields {
  objectKey: string;
  recordId: string;
  /** Look up a value by fieldKey (prefixed or bare) or scalar name. */
  get(key: string): unknown;
  /** Raw values keyed by every alias we resolved. */
  values: Record<string, unknown>;
}

function makeAccessor(objectKey: string, recordId: string, values: Record<string, unknown>): RecordFields {
  const bare = (k: string) => k.replace(new RegExp(`^${objectKey.replace('.', '\\.')}\\.`), '');
  return {
    objectKey,
    recordId,
    values,
    get(key: string) {
      if (key in values) return values[key];
      const b = bare(key);
      if (b in values) return values[b];
      const prefixed = `${objectKey}.${key}`;
      return prefixed in values ? values[prefixed] : undefined;
    },
  };
}

/** Read a contact's fields keyed by fieldKey + scalar name. */
async function readContact(recordId: string, client: GhlClient): Promise<RecordFields> {
  const [contact, catalog] = await Promise.all([getContact(recordId, client), getCatalog('contact', { client })]);
  const values: Record<string, unknown> = {};
  if (contact) {
    for (const k of CONTACT_SCALAR_KEYS) if ((contact as any)[k] != null) values[k] = (contact as any)[k];
    for (const cf of contact.customFields ?? []) {
      const def = catalog.byId[cf.id];
      if (def?.fieldKey) values[def.fieldKey] = cf.value;
    }
  }
  return makeAccessor('contact', recordId, values);
}

/** Read an objects-API record (business/opportunity/custom_objects.*) keyed by bare + fieldKey. */
async function readObjectRecord(objectKey: string, recordId: string, client: GhlClient): Promise<RecordFields> {
  const data = await client.request<any>({ path: `/objects/${objectKey}/records/${recordId}` });
  const rec = data.record ?? data;
  const props = (rec?.properties ?? {}) as Record<string, unknown>;
  const values: Record<string, unknown> = {};
  for (const [bareKey, val] of Object.entries(props)) {
    values[bareKey] = val;
    values[`${objectKey}.${bareKey}`] = val;
  }
  // Standard top-level fields (e.g. opportunity name/status) if present outside properties.
  for (const k of ['name', 'status', 'monetaryValue', 'email', 'phone', 'website']) {
    if (rec && rec[k] != null && !(k in values)) values[k] = rec[k];
  }
  return makeAccessor(objectKey, recordId, values);
}

const OPP_SCALAR_KEYS = ['name', 'status', 'monetaryValue', 'contactId', 'pipelineId', 'pipelineStageId', 'source'] as const;

/** Read an opportunity's fields. Opportunities key custom fields by id (like contacts):
 *  customFields [{ id, fieldValue }] — mapped to fieldKey via the opportunity catalog. */
async function readOpportunity(recordId: string, client: GhlClient): Promise<RecordFields> {
  const [data, catalog] = await Promise.all([
    client.request<any>({ path: `/opportunities/${recordId}`, autoLocation: false }),
    getCatalog('opportunity', { client }),
  ]);
  const o = data.opportunity ?? data;
  const values: Record<string, unknown> = {};
  if (o) {
    for (const k of OPP_SCALAR_KEYS) if (o[k] != null) values[k] = o[k];
    for (const cf of o.customFields ?? []) {
      const def = catalog.byId[cf.id];
      const val = cf.fieldValue ?? cf.fieldValueString ?? cf.fieldValueArray ?? cf.value;
      if (def?.fieldKey) values[def.fieldKey] = val;
    }
  }
  return makeAccessor('opportunity', recordId, values);
}

export function readRecordFields(objectKey: string, recordId: string, client: GhlClient = ghl()): Promise<RecordFields> {
  if (objectKey === 'contact') return readContact(recordId, client);
  if (objectKey === 'opportunity') return readOpportunity(recordId, client);
  return readObjectRecord(objectKey, recordId, client);
}
