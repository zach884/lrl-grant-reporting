// lib/ghl/associations.ts — relation records between objects (e.g. Activity<->Contact).
//
// Create: POST /associations/relations { associationId, firstRecordId, secondRecordId }.
// Query (confirmed live): the "everything attached to this record" call is UNRELIABLE
// for records with mixed link types (a company with both a contact link and an activity
// link returned only one, with a wrong total). Query ONE association type at a time, or
// use the contact-side scalar (`businessId`) for Company<->Contact.

import { GhlClient, ghl } from './client';

export interface RelationInput {
  associationId: string;
  firstRecordId: string;
  secondRecordId: string;
}

export async function createRelation(
  input: RelationInput,
  client: GhlClient = ghl(),
): Promise<any> {
  return client.request<any>({
    method: 'POST',
    path: '/associations/relations',
    autoLocation: false,
    body: { locationId: client.locationId, ...input },
  });
}

export const BUSINESSES_CONTACTS_ASSOCIATION = 'BUSINESSES_CONTACTS_ASSOCIATION';

/** A normalized association definition (which two objects are related, and how). */
export interface AssociationDef {
  id: string;
  key: string;
  first: { objectKey: string; label: string };
  second: { objectKey: string; label: string };
}

/**
 * List the location's association definitions (the object-relationship graph). Powers the
 * mapper's object pickers: a GHL↔GHL sync can only traverse a pair that shares an association.
 */
export async function listAssociationDefs(client: GhlClient = ghl()): Promise<AssociationDef[]> {
  const data = await client.request<any>({ path: '/associations/', params: { limit: 100 } });
  const defs: any[] = data.associations ?? data.data ?? [];
  return defs
    .filter((d) => d.firstObjectKey && d.secondObjectKey)
    .map((d) => ({
      id: d.id,
      key: d.key ?? d.id,
      first: { objectKey: d.firstObjectKey, label: d.firstObjectLabel ?? d.firstObjectKey },
      second: { objectKey: d.secondObjectKey, label: d.secondObjectLabel ?? d.secondObjectKey },
    }));
}

// Association ids are location-scoped and opaque, so hardcoding them (as the v1 activity route did)
// breaks silently the moment an association is recreated. Resolve by KEY instead — the key is the
// stable name we chose (`company_activity`, `activity_contact`, …). Cached per process with the same
// 10-min TTL as the field catalogs; definitions change about once a month.
const ASSOC_TTL_MS = 10 * 60 * 1000;
let assocCache: { at: number; byKey: Map<string, string> } | null = null;

/**
 * The id of the association definition with this key, or null if the location has no such
 * association. Callers must treat null as "cannot link" and report it — never fall back to
 * guessing an id.
 */
export async function resolveAssociationId(
  key: string,
  client: GhlClient = ghl(),
  opts: { force?: boolean } = {},
): Promise<string | null> {
  if (opts.force || !assocCache || Date.now() - assocCache.at > ASSOC_TTL_MS) {
    const defs = await listAssociationDefs(client);
    assocCache = { at: Date.now(), byKey: new Map(defs.map((d) => [d.key, d.id])) };
  }
  return assocCache.byKey.get(key) ?? null;
}

/** Drop the cached association map (after creating an association, or in tests). */
export function clearAssociationCache(): void {
  assocCache = null;
  defCache = null;
}

let defCache: { at: number; byKey: Map<string, AssociationDef> } | null = null;

/**
 * The full definition for a key — id AND which object sits on each side.
 *
 * The sides matter and CANNOT be assumed: GHL **swapped them** when creating a custom-object ↔
 * custom-object association (sent `custom_objects.resources` first + `custom_objects.activities`
 * second; stored the reverse), and posting a relation in the wrong order fails with
 * `422 Invalid record id ... for association`. Verified live 2026-08-19. Read the definition.
 */
export async function resolveAssociationDef(
  key: string,
  client: GhlClient = ghl(),
  opts: { force?: boolean } = {},
): Promise<AssociationDef | null> {
  if (opts.force || !defCache || Date.now() - defCache.at > ASSOC_TTL_MS) {
    const defs = await listAssociationDefs(client);
    defCache = { at: Date.now(), byKey: new Map(defs.map((d) => [d.key, d])) };
  }
  return defCache.byKey.get(key) ?? null;
}

/**
 * All contact ids associated with a company (the real-time down-sync fan-out roster).
 * Uses the associations graph filtered to contact links — targeted + instant for
 * established links (a just-created link may lag a few seconds; the reconcile sweep
 * backstops that). Far cheaper than enumerating every contact.
 */
export async function getAssociatedContactIds(
  companyId: string,
  client: GhlClient = ghl(),
): Promise<string[]> {
  const data = await client.request<any>({
    path: `/associations/relations/${companyId}`,
    params: { limit: 100 },
  });
  const rels: any[] = data.relations ?? [];
  return rels
    .filter((r) => r.secondObjectKey === 'contact')
    .map((r) => r.secondRecordId as string)
    .filter(Boolean);
}

/**
 * EVERY relation on a record, paged. The endpoint caps at 100 per call and takes `limit` + `skip`
 * (`page`/`offset` both 422); `total` is accurate, so we page until we have it.
 *
 * Paging matters for companies specifically: the nightly scorer appends a Client Stage record per
 * scoring event, so a company's relation list grows without bound and a single 100-row call would
 * eventually push its ACTIVITY links off the end — a timeline that silently loses its oldest rows.
 * Verified live 2026-08-19: skip works, total is correct, and mixed link types come back together
 * (the older "unreliable for mixed types" note above did not reproduce).
 */
export async function getAllRelations(
  recordId: string,
  client: GhlClient = ghl(),
  opts: { pageSize?: number; max?: number } = {},
): Promise<any[]> {
  const pageSize = opts.pageSize ?? 100;
  const max = opts.max ?? 1000;
  const out: any[] = [];
  let skip = 0;
  let total = Infinity;
  while (out.length < Math.min(total, max)) {
    const data = await client.request<any>({
      path: `/associations/relations/${recordId}`,
      params: skip ? { limit: pageSize, skip } : { limit: pageSize },
    });
    const rels: any[] = data.relations ?? [];
    if (typeof data.total === 'number') total = data.total;
    out.push(...rels);
    if (rels.length < pageSize) break;
    skip += pageSize;
  }
  return out;
}

/** Ids of records of `objectKey` related to `recordId`, following relations in either direction. */
export async function getRelatedRecordIds(
  recordId: string,
  objectKey: string,
  client: GhlClient = ghl(),
): Promise<string[]> {
  const rels = await getAllRelations(recordId, client);
  const ids = rels.map((r) =>
    r.secondObjectKey === objectKey && r.secondRecordId !== recordId
      ? r.secondRecordId
      : r.firstObjectKey === objectKey && r.firstRecordId !== recordId
        ? r.firstRecordId
        : undefined,
  );
  return Array.from(new Set(ids.filter(Boolean) as string[]));
}

/**
 * Relations for a record, scoped to a single associationId. The endpoint does NOT accept
 * an `associationId` query param (returns 422), so we fetch the record's relations and
 * filter client-side — matching how getAssociatedContactIds filters by object key.
 */
export async function getRelations(
  recordId: string,
  associationId: string,
  client: GhlClient = ghl(),
): Promise<any[]> {
  const data = await client.request<any>({
    path: `/associations/relations/${recordId}`,
    params: { limit: 100 },
  });
  const rels: any[] = data.relations ?? [];
  // Keep relations for this association; relations that don't carry an associationId are kept
  // (the caller further filters by target object key).
  return rels.filter((r) => !associationId || !r.associationId || r.associationId === associationId);
}
