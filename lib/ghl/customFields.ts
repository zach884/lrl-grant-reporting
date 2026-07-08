// lib/ghl/customFields.ts — read the contact + company field catalogs.
//
// Business (system) object fields:  GET /custom-fields/object-key/business?locationId=
// Contact/opportunity fields:       GET /locations/{loc}/customFields
//   (the /custom-fields/ endpoint REJECTS objectKey contact/opportunity).
//
// Caveat (confirmed live): picklist `options` come back INCONSISTENTLY on these list
// endpoints. When exact option lists matter, verify in the UI or via a single-field GET.

import { GhlClient, ghl } from './client';
import { CustomFieldCatalog, CustomFieldDef, CustomFieldFolder } from './types';

function index(fields: CustomFieldDef[], folders: CustomFieldFolder[]): CustomFieldCatalog {
  const byKey: Record<string, CustomFieldDef> = {};
  const byId: Record<string, CustomFieldDef> = {};
  for (const f of fields) {
    if (f.fieldKey) byKey[f.fieldKey] = f;
    if (f.id) byId[f.id] = f;
  }
  return { fields, folders, byKey, byId };
}

function normalizeField(f: any): CustomFieldDef {
  return {
    id: f.id,
    name: f.name,
    fieldKey: f.fieldKey ?? f.key ?? '',
    dataType: f.dataType,
    parentId: f.parentId,
    options: f.options ?? f.picklistOptions ?? undefined,
  };
}

/** Company (`business`) object custom fields + folders. */
export async function getBusinessFieldCatalog(client: GhlClient = ghl()): Promise<CustomFieldCatalog> {
  const data = await client.request<any>({
    path: '/custom-fields/object-key/business',
  });
  const fields = (data.fields ?? []).map(normalizeField);
  const folders: CustomFieldFolder[] = (data.folders ?? []).map((f: any) => ({
    id: f.id,
    name: f.name,
  }));
  return index(fields, folders);
}

/** Contact custom fields (via the location endpoint — the only one that returns them). */
export async function getContactFieldCatalog(client: GhlClient = ghl()): Promise<CustomFieldCatalog> {
  const data = await client.request<any>({
    path: `/locations/${client.locationId}/customFields`,
    autoLocation: false,
  });
  const raw = data.customFields ?? data.fields ?? [];
  // Keep only contact-model fields (endpoint can include opportunity/custom object fields).
  const fields = raw
    .filter((f: any) => !f.model || f.model === 'contact')
    .map(normalizeField);
  return index(fields, []);
}

/**
 * Single-field GET — the reliable way to read one field's picklist options
 * (the list endpoints drop them). Business + contact both resolve by field id.
 */
export async function getCustomField(
  fieldId: string,
  client: GhlClient = ghl(),
): Promise<CustomFieldDef | null> {
  const data = await client.request<any>({ path: `/custom-fields/${fieldId}` });
  const f = data.customField ?? data.field ?? data;
  if (!f || !f.id) return null;
  return normalizeField(f);
}
