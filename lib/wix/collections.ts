// lib/wix/collections.ts — Wix Data API operations (collections + items + references).
//
// Endpoints (Wix Data v2, base https://www.wixapis.com):
//   GET  /wix-data/v2/collections                 list collections
//   GET  /wix-data/v2/collections/{id}            collection schema (fields[])
//   POST /wix-data/v2/items/query                 query items (match-key lookup)
//   POST /wix-data/v2/items                        insert item
//   POST /wix-data/v2/bulk/items/patch            partial update (SET_FIELD) — preferred
//   POST /wix-data/v2/collections/create-field    add a column (e.g. the ghl*Id key)
//   POST /wix-data/v2/items/replace-references     set a (multi-)reference field
// Reads return partial items on list/query; re-GET the full item before diffing.

import { WixClient, wix } from './client';
import type { WixCollectionSchema, WixCollectionSummary, WixColumn, WixItem } from './types';

function normColumn(f: any): WixColumn {
  const col: WixColumn = {
    key: f.key,
    displayName: f.displayName ?? f.key,
    type: f.type,
    systemField: !!f.systemField,
    readOnly: !!f.readOnly,
  };
  const mr = f.typeMetadata?.multiReference ?? f.typeMetadata?.reference;
  if (mr) {
    col.referencedCollectionId = mr.referencedCollectionId;
    col.referencingFieldKey = mr.referencingFieldKey;
  }
  return col;
}

/** List the site's USER-CREATED CMS collections (id + display name).
 *
 * Wix returns every collection here — including installed-app system collections (Stores'
 * Products/Categories, Bookings' Schedules, Blog's Posts/Categories/Tags, Members' *Data,
 * Forms/Coupons/Badges, etc.) which the mapper can't meaningfully target. We keep only
 * `collectionType === 'NATIVE'` ("User-created collection" per the Wix Data API), i.e. what
 * shows under "Your Collections" in the CMS. Defensive: if the API omits collectionType
 * entirely, fall back to all collections rather than blanking the dropdown. */
export async function listCollections(client: WixClient = wix()): Promise<WixCollectionSummary[]> {
  const data = await client.request<any>({
    method: 'GET',
    path: '/wix-data/v2/collections',
    params: { 'paging.limit': 200 },
  });
  const cols: any[] = data.collections ?? data.dataCollections ?? [];
  const typed = cols.some((c) => c.collectionType);
  const userCollections = typed ? cols.filter((c) => c.collectionType === 'NATIVE') : cols;
  return userCollections.map((c: any) => ({ id: c.id ?? c._id, displayName: c.displayName ?? c.id }));
}

/** Full schema for one collection: writable + system columns with types. */
export async function getCollectionSchema(
  collectionId: string,
  client: WixClient = wix(),
): Promise<WixCollectionSchema> {
  const data = await client.request<any>({
    method: 'GET',
    path: `/wix-data/v2/collections/${encodeURIComponent(collectionId)}`,
  });
  const c = data.collection ?? data;
  return {
    id: c.id ?? collectionId,
    displayName: c.displayName ?? collectionId,
    displayField: c.displayField,
    columns: (c.fields ?? []).map(normColumn),
  };
}

/** Query up to `limit` items whose `column` equals `value`, INCLUDING drafts. Draft inclusion is
 *  essential for dedup: a drafted (hidden) row is invisible to a normal query, so without this the
 *  sync would create a DUPLICATE of a person who already exists as a draft.
 *
 *  `includeReferencedItems` (property names, max 50 per the Data API) inlines each named
 *  reference/multi-reference field's target items in the result — that is how the sync reads a
 *  row's CURRENT references so it can skip a no-op `replaceReferences`. */
export async function queryItemsByColumn(
  collectionId: string,
  column: string,
  value: string,
  limit: number,
  client: WixClient = wix(),
  includeReferencedItems?: string[],
): Promise<WixItem[]> {
  const data = await client.request<any>({
    method: 'POST',
    path: '/wix-data/v2/items/query',
    body: {
      dataCollectionId: collectionId,
      query: { filter: { [column]: value }, paging: { limit } },
      publishPluginOptions: { includeDraftItems: true },
      ...(includeReferencedItems?.length ? { includeReferencedItems: includeReferencedItems.slice(0, 50) } : {}),
    },
  });
  const items = data.dataItems ?? data.items ?? [];
  return items.map((it: any) => it.data ?? it.dataItem?.data ?? it);
}

/** Find the single item whose `column` equals `value` (the upsert match lookup, drafts included). */
export async function queryItemByMatch(
  collectionId: string,
  column: string,
  value: string,
  client: WixClient = wix(),
  includeReferencedItems?: string[],
): Promise<WixItem | null> {
  const items = await queryItemsByColumn(collectionId, column, value, 1, client, includeReferencedItems);
  return items[0] ?? null;
}

/** The item ids referenced by a (multi-)reference field value, as returned by
 *  `includeReferencedItems` (full item objects) or a raw id / id array. */
export function referencedIds(value: unknown): string[] {
  if (value == null || value === '') return [];
  const arr = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const entry of arr) {
    const id =
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object'
          ? String((entry as any)._id ?? (entry as any).id ?? '')
          : '';
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Full item by id (re-read before diffing — query returns partial items). */
export async function getItem(
  collectionId: string,
  itemId: string,
  client: WixClient = wix(),
): Promise<WixItem | null> {
  const data = await client.request<any>({
    method: 'GET',
    path: `/wix-data/v2/items/${encodeURIComponent(itemId)}`,
    params: { dataCollectionId: collectionId },
  });
  const item = data.dataItem ?? data;
  return item?.data ?? item ?? null;
}

/** Insert a new item; returns the created item (with _id). */
export async function insertItem(
  collectionId: string,
  data: Record<string, unknown>,
  client: WixClient = wix(),
): Promise<WixItem> {
  const res = await client.request<any>({
    method: 'POST',
    path: '/wix-data/v2/items',
    body: { dataCollectionId: collectionId, dataItem: { data } },
  });
  const item = res.dataItem ?? res;
  return item?.data ?? item;
}

export interface FieldModification {
  fieldPath: string;
  action?: 'SET_FIELD' | 'REMOVE_FIELD';
  value?: unknown;
}

/** Partial update of one item via bulk patch (SET_FIELD per field). `includeDraftItems` is always
 *  set so patches also apply to DRAFT rows — required for Publish-plugin collections (Wix rejects a
 *  draft-item modification without it, WDE0197), and harmless for published ones. */
export async function patchItem(
  collectionId: string,
  itemId: string,
  mods: FieldModification[],
  client: WixClient = wix(),
): Promise<void> {
  await client.request<any>({
    method: 'POST',
    path: '/wix-data/v2/bulk/items/patch',
    body: {
      dataCollectionId: collectionId,
      patches: [
        {
          dataItemId: itemId,
          fieldModifications: mods.map((m) => ({
            fieldPath: m.fieldPath,
            action: m.action ?? 'SET_FIELD',
            ...(m.action === 'REMOVE_FIELD' ? {} : { setFieldOptions: { value: m.value } }),
          })),
        },
      ],
      publishPluginOptions: { includeDraftItems: true },
    },
  });
}

/** Set an item's Wix publish state ('PUBLISHED' shows it on the site, 'DRAFT' hides it). Verified
 *  against the live Team collection: `_publishStatus` is patchable both ways with includeDraftItems. */
export async function setPublishStatus(
  collectionId: string,
  itemId: string,
  status: 'PUBLISHED' | 'DRAFT',
  client: WixClient = wix(),
): Promise<void> {
  await patchItem(collectionId, itemId, [{ fieldPath: '_publishStatus', value: status }], client);
}

/** Add a column to a collection (used to create the ghl*Id match-key column if missing). */
export async function createField(
  collectionId: string,
  field: { key: string; displayName: string; type: string; description?: string },
  client: WixClient = wix(),
): Promise<void> {
  await client.request<any>({
    method: 'POST',
    path: '/wix-data/v2/collections/create-field',
    body: { dataCollectionId: collectionId, field },
  });
}

/** Set a (multi-)reference field's targets (replaces the whole set). */
export async function replaceReferences(
  collectionId: string,
  referringItemId: string,
  referringItemFieldName: string,
  newReferencedItemIds: string[],
  client: WixClient = wix(),
): Promise<void> {
  await client.request<any>({
    method: 'POST',
    path: '/wix-data/v2/items/replace-references',
    body: {
      dataCollectionId: collectionId,
      referringItemId,
      referringItemFieldName,
      newReferencedItemIds,
    },
  });
}

/** Normalize a display label for tolerant matching: case, surrounding/inner whitespace, and the
 *  punctuation that drifts between systems (GHL "i4.0" vs Wix "Industry 4.0" still won't match —
 *  that needs an explicit valueMap — but "Local" vs "LOCAL" and "A  B" vs "A B" will). */
function normalizeLabel(s: unknown): string {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Resolve display values to referenced-collection item ids (for REFERENCE targets).
 *
 * Reads the referenced collection ONCE and matches client-side rather than issuing a filtered query
 * per label. Two reasons: the Wix filter is case-SENSITIVE, so `Local` never matched Wix's `LOCAL`
 * and those references were silently dropped for months; and referenced collections here are tiny
 * (Programs has 6 rows, Collectives 3), so one read beats N.
 *
 * Matching is exact first, then case/whitespace-insensitive. Labels that are genuinely a DIFFERENT
 * name in Wix ("i4.0 Accelerator" vs "Industry 4.0 Accelerator") cannot be resolved here by design —
 * use the mapping row's `valueMap` for those. Unmatched labels are returned so the caller can report
 * them instead of quietly writing a partial reference set.
 */
export async function resolveReferenceIds(
  referencedCollectionId: string,
  displayField: string,
  labels: string[],
  client: WixClient = wix(),
): Promise<{ ids: string[]; unmatched: string[] }> {
  const data = await client.request<any>({
    method: 'POST',
    path: '/wix-data/v2/items/query',
    body: {
      dataCollectionId: referencedCollectionId,
      query: { paging: { limit: 1000 } },
    },
  });
  const items: any[] = (data.dataItems ?? data.items ?? []).map((it: any) => it.data ?? it.dataItem?.data ?? it);

  const exact = new Map<string, string>();
  const loose = new Map<string, string>();
  for (const it of items) {
    const label = it?.[displayField];
    if (label == null || !it?._id) continue;
    if (!exact.has(String(label))) exact.set(String(label), it._id);
    const n = normalizeLabel(label);
    if (n && !loose.has(n)) loose.set(n, it._id);
  }

  const ids: string[] = [];
  const unmatched: string[] = [];
  for (const label of labels) {
    const hit = exact.get(String(label)) ?? loose.get(normalizeLabel(label));
    if (hit) { if (!ids.includes(hit)) ids.push(hit); }
    else unmatched.push(label);
  }
  return { ids, unmatched };
}

/**
 * Bulk-delete items by id (Wix Data v2 `POST /bulk/items/delete`, batched at 100).
 * Returns the number of ids sent for deletion. Destructive — callers must gate this behind
 * explicit confirmation.
 */
export async function bulkDeleteItems(
  collectionId: string,
  itemIds: string[],
  client: WixClient = wix(),
): Promise<number> {
  let removed = 0;
  for (let i = 0; i < itemIds.length; i += 100) {
    const batch = itemIds.slice(i, i + 100);
    const res = await client.request<any>({
      method: 'POST',
      path: '/wix-data/v2/bulk/items/remove', // Wix Data v2 calls delete "remove"
      // includeDraftItems is REQUIRED to modify draft rows (WDE0197), which is what the
      // ungated inserts created.
      body: { dataCollectionId: collectionId, dataItemIds: batch, publishPluginOptions: { includeDraftItems: true } },
    });
    removed += res?.bulkActionMetadata?.totalSuccesses ?? 0;
  }
  return removed;
}
