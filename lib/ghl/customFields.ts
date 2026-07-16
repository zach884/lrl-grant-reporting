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

function normOptions(raw: any): CustomFieldDef['options'] {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.map((o: any) =>
    typeof o === 'string'
      ? { key: o, label: o }
      : { key: o.key ?? o.id ?? o.value ?? o.label, label: o.label ?? o.name ?? String(o.value ?? o.key ?? '') },
  );
  return out.length ? out : undefined;
}

// TEXTBOX_LIST rows come from picklistOptions as [{id,label,prefillValue}].
function normRows(raw: any): CustomFieldDef['rows'] {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((o: any) => o && o.id).map((o: any) => ({ id: o.id, label: o.label ?? '' }));
  return out.length ? out : undefined;
}

function normalizeField(f: any): CustomFieldDef {
  return {
    id: f.id,
    name: f.name,
    fieldKey: f.fieldKey ?? f.key ?? '',
    dataType: f.dataType,
    parentId: f.parentId,
    position: typeof f.position === 'number' ? f.position : undefined,
    options: normOptions(f.options ?? f.picklistOptions),
    rows: f.dataType === 'TEXTBOX_LIST' ? normRows(f.picklistOptions) : undefined,
  };
}

/** Catalog from the object-key endpoint (business + custom_objects.*; NOT contact/opportunity). */
export async function getObjectKeyFieldCatalog(objectKey: string, client: GhlClient = ghl()): Promise<CustomFieldCatalog> {
  const data = await client.request<any>({ path: `/custom-fields/object-key/${objectKey}` });
  const fields = (data.fields ?? []).map(normalizeField);
  const folders: CustomFieldFolder[] = (data.folders ?? []).map((f: any) => ({
    id: f.id,
    name: f.name,
    position: typeof f.position === 'number' ? f.position : undefined,
  }));
  return index(fields, folders);
}

/** Catalog from the location endpoint, filtered to one model (contact or opportunity — the
 *  object-key endpoint rejects those). Resolves folder objects by id like the contact catalog. */
export async function getLocationModelFieldCatalog(model: 'contact' | 'opportunity', client: GhlClient = ghl()): Promise<CustomFieldCatalog> {
  const data = await client.request<any>({
    path: `/locations/${client.locationId}/customFields`,
    autoLocation: false,
  });
  const raw = data.customFields ?? data.fields ?? [];
  // The endpoint returns fields for multiple models; keep only this one (contact fields have no
  // model tag, so treat untagged as contact).
  const fields = raw
    .filter((f: any) => (model === 'contact' ? !f.model || f.model === 'contact' : f.model === model))
    .map(normalizeField);

  // Folder objects aren't in the list endpoint; each is a customField with documentType:'folder',
  // fetchable by id — resolve distinct parents so the UI can group + order by folder.
  const parentIds = Array.from(new Set(fields.map((f: CustomFieldDef) => f.parentId).filter(Boolean))) as string[];
  const folders: CustomFieldFolder[] = (
    await Promise.all(
      parentIds.map(async (id) => {
        try {
          const fd = await client.request<any>({ path: `/locations/${client.locationId}/customFields/${id}`, autoLocation: false });
          const f = fd.customField ?? fd;
          if (f?.id && f.documentType === 'folder') {
            return { id: f.id, name: f.name, position: typeof f.position === 'number' ? f.position : undefined };
          }
        } catch { /* skip a folder we can't resolve */ }
        return null;
      }),
    )
  ).filter(Boolean) as CustomFieldFolder[];

  return index(fields, folders);
}

/** Company (`business`) object custom fields + folders. */
export function getBusinessFieldCatalog(client: GhlClient = ghl()): Promise<CustomFieldCatalog> {
  return getObjectKeyFieldCatalog('business', client);
}

/** Contact custom fields (via the location endpoint — the only one that returns them). */
export function getContactFieldCatalog(client: GhlClient = ghl()): Promise<CustomFieldCatalog> {
  return getLocationModelFieldCatalog('contact', client);
}

/**
 * Object-agnostic catalog: dispatch to the right endpoint per object.
 *   contact / opportunity → location endpoint (object-key rejects these)
 *   business / custom_objects.* → object-key endpoint
 */
export function getFieldCatalog(objectKey: string, client: GhlClient = ghl()): Promise<CustomFieldCatalog> {
  if (objectKey === 'contact' || objectKey === 'opportunity') return getLocationModelFieldCatalog(objectKey, client);
  return getObjectKeyFieldCatalog(objectKey, client);
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
