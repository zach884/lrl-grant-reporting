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

/** Find the single item whose `column` equals `value` (the upsert match lookup). */
export async function queryItemByMatch(
  collectionId: string,
  column: string,
  value: string,
  client: WixClient = wix(),
): Promise<WixItem | null> {
  const data = await client.request<any>({
    method: 'POST',
    path: '/wix-data/v2/items/query',
    body: {
      dataCollectionId: collectionId,
      query: { filter: { [column]: value }, paging: { limit: 1 } },
    },
  });
  const items = data.dataItems ?? data.items ?? [];
  const first = items[0];
  return first ? (first.data ?? first.dataItem?.data ?? first) : null;
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

/** Partial update of one item via bulk patch (SET_FIELD per field). */
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
    },
  });
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

/**
 * Resolve display values to referenced-collection item ids (for REFERENCE targets).
 * Queries the referenced collection by its display field for each label; returns the
 * ids that matched (labels with no match are dropped — caller decides how to warn).
 */
export async function resolveReferenceIds(
  referencedCollectionId: string,
  displayField: string,
  labels: string[],
  client: WixClient = wix(),
): Promise<{ ids: string[]; unmatched: string[] }> {
  const ids: string[] = [];
  const unmatched: string[] = [];
  for (const label of labels) {
    const data = await client.request<any>({
      method: 'POST',
      path: '/wix-data/v2/items/query',
      body: {
        dataCollectionId: referencedCollectionId,
        query: { filter: { [displayField]: label }, paging: { limit: 1 } },
      },
    });
    const items = data.dataItems ?? data.items ?? [];
    const item = items[0]?.data ?? items[0];
    if (item?._id) ids.push(item._id);
    else unmatched.push(label);
  }
  return { ids, unmatched };
}
