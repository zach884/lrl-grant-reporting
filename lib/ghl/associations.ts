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
 * Relations for a record, filtered to a single associationId (deterministic).
 * Do NOT rely on the unfiltered result for rollups.
 */
export async function getRelations(
  recordId: string,
  associationId: string,
  client: GhlClient = ghl(),
): Promise<any[]> {
  const data = await client.request<any>({
    path: `/associations/relations/${recordId}`,
    params: { associationId },
  });
  return data.relations ?? [];
}
