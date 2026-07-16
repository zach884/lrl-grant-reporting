// lib/wix-sync/sync.ts — outbound sync of one GHL record to its Wix CMS row.
//
// Flow: read the GHL source record -> coerce each mapped field to its Wix column ->
// query the target collection by the match key -> INSERT (new) or bulk-PATCH (existing)
// the plain-value fields -> import IMAGE files + set (MULTI_)REFERENCE targets as a
// second pass (they need the item id / async media). An equality guard makes re-runs
// no-ops. Nothing is written unless opts.apply is true (dry-run returns the same plan).

import { getContact } from '../ghl/contacts';
import { GhlClient, ghl } from '../ghl/client';
import type { Contact, CustomFieldCatalog, GhlFieldOption } from '../ghl/types';
import type { WixMappingSet } from '../mapping/wixTypes';
import { WixClient, wix } from '../wix/client';
import { coerceToWix, isUnwritableWixType, type GhlSourceType } from '../wix/coerce';
import {
  getCollectionSchema,
  insertItem,
  patchItem,
  queryItemByMatch,
  replaceReferences,
  resolveReferenceIds,
  type FieldModification,
} from '../wix/collections';
import { importImageFromUrl, toImageFieldValue } from '../wix/media';
import type { WixCollectionSchema, WixColumn } from '../wix/types';
import type { WixFieldChange, WixSyncResult } from './types';

interface SourceField {
  value: unknown;
  ghlType: GhlSourceType;
  options?: GhlFieldOption[];
}

/** Read a source field value (standard scalar or custom field) off a GHL contact. */
export function resolveContactField(
  contact: Contact,
  catalog: CustomFieldCatalog,
  key: string,
): SourceField {
  const scalars: Record<string, unknown> = {
    id: contact.id,
    firstName: contact.firstName,
    lastName: contact.lastName,
    fullName: [contact.firstName, contact.lastName].filter(Boolean).join(' '),
    email: contact.email,
    phone: contact.phone,
    companyName: contact.companyName,
    website: contact.website,
    address1: contact.address1,
    city: contact.city,
    state: contact.state,
    postalCode: contact.postalCode,
    country: contact.country,
    businessId: contact.businessId,
  };
  if (key in scalars) return { value: scalars[key], ghlType: 'scalar' };
  const def = catalog.byKey[key];
  if (def) {
    const cf = (contact.customFields ?? []).find((f) => f.id === def.id);
    return { value: cf?.value, ghlType: def.dataType, options: def.options };
  }
  return { value: undefined, ghlType: 'scalar' };
}

function normForCompare(v: unknown): unknown {
  if (v && typeof v === 'object' && '$date' in (v as any)) return String((v as any).$date).slice(0, 10);
  if (typeof v === 'string') {
    const s = v.trim();
    return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s.toLowerCase();
  }
  if (Array.isArray(v)) return [...v].map((x) => String(x)).sort();
  return v;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  const na = normForCompare(a);
  const nb = normForCompare(b);
  return JSON.stringify(na) === JSON.stringify(nb);
}

/** Sync one GHL contact into the mapping set's Wix collection. */
export async function syncContactToWix(
  contactId: string,
  set: WixMappingSet,
  catalog: CustomFieldCatalog,
  wixSchema: WixCollectionSchema,
  opts: { apply: boolean; client?: WixClient; ghlClient?: GhlClient },
): Promise<WixSyncResult> {
  const client = opts.client ?? wix();
  const gclient = opts.ghlClient ?? ghl();
  const colById = new Map(wixSchema.columns.map((c) => [c.key, c] as const));

  const contact = await getContact(contactId, gclient);
  if (!contact) {
    return { sourceId: contactId, action: 'skip', written: [], unchanged: 0, skipped: [], dryRun: !opts.apply, note: 'source contact not found' };
  }

  const matchValue = resolveContactField(contact, catalog, set.matchSourceField).value;
  if (matchValue == null || matchValue === '') {
    return { sourceId: contactId, action: 'skip', written: [], unchanged: 0, skipped: [], dryRun: !opts.apply, note: `match field "${set.matchSourceField}" is empty` };
  }

  const existing = await queryItemByMatch(set.wixCollectionId, set.matchTargetColumn, String(matchValue), client);

  const written: WixFieldChange[] = [];
  const skipped: Array<{ targetColumn: string; reason: string }> = [];
  let unchanged = 0;

  const valueMods: FieldModification[] = []; // plain-value changes (patch/insert body)
  const insertBody: Record<string, unknown> = {};
  const imageIntents: Array<{ col: string; sourceUrl: string; displayName?: string }> = [];
  const refIntents: Array<{ col: WixColumn; labels: string[] }> = [];

  for (const row of set.rows) {
    const col = colById.get(row.targetColumnKey);
    if (!col) { skipped.push({ targetColumn: row.targetColumnKey, reason: 'column not on collection' }); continue; }
    if (isUnwritableWixType(String(col.type), col.systemField)) { skipped.push({ targetColumn: col.key, reason: `unwritable Wix type ${col.type}` }); continue; }

    const src = resolveContactField(contact, catalog, row.sourceFieldKey);
    const result = coerceToWix(src.value, src.ghlType, String(col.type), row.transform, src.options);

    if (result.kind === 'skip') { if (result.reason !== 'empty') skipped.push({ targetColumn: col.key, reason: result.reason }); continue; }

    if (result.kind === 'value') {
      const current = existing ? (existing as any)[col.key] : undefined;
      if (existing && valuesEqual(current, result.value)) { unchanged++; continue; }
      written.push({ targetColumn: col.key, from: current, to: result.value, via: 'value' });
      valueMods.push({ fieldPath: col.key, value: result.value });
      insertBody[col.key] = result.value;
    } else if (result.kind === 'image') {
      imageIntents.push({ col: col.key, sourceUrl: result.sourceUrl, displayName: result.displayName });
      written.push({ targetColumn: col.key, to: result.sourceUrl, via: 'image' });
    } else if (result.kind === 'reference') {
      refIntents.push({ col, labels: result.labels });
      written.push({ targetColumn: col.key, to: result.labels, via: 'reference' });
    }
  }

  // Always ensure the match key is present on inserts.
  insertBody[set.matchTargetColumn] = String(matchValue);

  const action: WixSyncResult['action'] =
    written.length === 0 && existing ? 'noop' : existing ? 'patch' : 'insert';

  if (!opts.apply) {
    return { sourceId: contactId, itemId: (existing as any)?._id, action, written, unchanged, skipped, dryRun: true };
  }

  // --- apply ---
  // 1) resolve image intents (import to Media Manager) into concrete field values.
  for (const img of imageIntents) {
    try {
      const file = await importImageFromUrl(img.sourceUrl, { displayName: img.displayName }, client);
      const value = toImageFieldValue(file);
      valueMods.push({ fieldPath: img.col, value });
      insertBody[img.col] = value;
    } catch (e: any) {
      skipped.push({ targetColumn: img.col, reason: `image import failed: ${e?.message ?? e}` });
    }
  }

  // 2) upsert the plain-value + image fields.
  let itemId = (existing as any)?._id as string | undefined;
  if (existing && itemId) {
    if (valueMods.length) await patchItem(set.wixCollectionId, itemId, valueMods, client);
  } else {
    const created = await insertItem(set.wixCollectionId, insertBody, client);
    itemId = (created as any)?._id;
  }

  // 3) reference intents (need the item id + the referenced collection's display field).
  for (const ref of refIntents) {
    const refCollId = ref.col.referencedCollectionId;
    if (!itemId || !refCollId) { skipped.push({ targetColumn: ref.col.key, reason: 'missing item id or referenced collection' }); continue; }
    try {
      const refSchema = await getCollectionSchema(refCollId, client);
      const displayField = refSchema.displayField ?? 'title';
      const { ids, unmatched } = await resolveReferenceIds(refCollId, displayField, ref.labels, client);
      if (unmatched.length) skipped.push({ targetColumn: ref.col.key, reason: `unmatched references: ${unmatched.join(', ')}` });
      if (ids.length) await replaceReferences(set.wixCollectionId, itemId, ref.col.key, ids, client);
    } catch (e: any) {
      skipped.push({ targetColumn: ref.col.key, reason: `reference write failed: ${e?.message ?? e}` });
    }
  }

  return { sourceId: contactId, itemId, action, written, unchanged, skipped, dryRun: false };
}
