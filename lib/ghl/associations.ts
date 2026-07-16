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
