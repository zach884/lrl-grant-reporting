// lib/sync/traverse.ts — resolve a connection's counterpart record ids from a source record.
//
// Two traversal modes, encoded in the connection's `associationId` string:
//   - "<associationId>"          → GHL association graph: getRelations(sourceId) filtered to
//                                   the association + target object.
//   - "scalar:<on>:<field>"      → scalar foreign-key link (how THIS account actually links
//                                   records, e.g. opportunity.contactId, contact.businessId):
//       on='source' → the source record carries the target's id in <field> (one counterpart).
//       on='target' → target records carry the source id in <field> (fan-out; query them).

import { getRelations } from '../ghl/associations';
import { getContact, listContactsByBusiness } from '../ghl/contacts';
import { GhlClient, ghl } from '../ghl/client';

export interface TraversalConnection {
  sourceObject: string;
  targetObject: string;
  associationId: string; // association id OR "scalar:<on>:<field>"
}

function fromRelations(relations: any[], targetObject: string, sourceId: string): string[] {
  const ids = new Set<string>();
  for (const r of relations) {
    if (r.firstObjectKey === targetObject && r.firstRecordId && r.firstRecordId !== sourceId) ids.add(r.firstRecordId);
    if (r.secondObjectKey === targetObject && r.secondRecordId && r.secondRecordId !== sourceId) ids.add(r.secondRecordId);
  }
  return Array.from(ids);
}

/** Read a single scalar foreign-key value off the source record. */
async function sourceScalar(sourceObject: string, sourceId: string, field: string, client: GhlClient): Promise<string | null> {
  if (sourceObject === 'contact') {
    const c = await getContact(sourceId, client);
    return (c as any)?.[field] ?? null;
  }
  if (sourceObject === 'opportunity') {
    const d = await client.request<any>({ path: `/opportunities/${sourceId}`, autoLocation: false });
    const o = d.opportunity ?? d;
    return o?.[field] ?? null;
  }
  // business/custom: read the record's properties
  const d = await client.request<any>({ path: `/objects/${sourceObject}/records/${sourceId}` });
  const rec = d.record ?? d;
  return rec?.properties?.[field] ?? rec?.[field] ?? null;
}

/** Query target records that carry `field === sourceId` (the fan-out case). */
async function targetsByScalar(targetObject: string, field: string, sourceId: string, client: GhlClient): Promise<string[]> {
  if (targetObject === 'opportunity') {
    // opportunities carry contactId; the search filter param is contact_id.
    const param = field === 'contactId' ? 'contact_id' : field;
    const d = await client.request<any>({ path: '/opportunities/search', params: { location_id: client.locationId, [param]: sourceId }, autoLocation: false });
    return (d.opportunities ?? []).map((o: any) => o.id).filter(Boolean);
  }
  if (targetObject === 'contact' && field === 'businessId') {
    const contacts = await listContactsByBusiness(sourceId, client);
    return contacts.map((c) => c.id);
  }
  // custom objects: search by property filter
  const d = await client.request<any>({ method: 'POST', path: `/objects/${targetObject}/records/search`, body: { locationId: client.locationId, query: { [field]: sourceId } } });
  return (d.records ?? d.data ?? []).map((r: any) => r.id).filter(Boolean);
}

/** Resolve the target-side record ids for a connection from one source record. */
export async function resolveCounterpartIds(
  connection: TraversalConnection,
  sourceRecordId: string,
  client: GhlClient = ghl(),
): Promise<string[]> {
  const spec = connection.associationId;
  if (spec?.startsWith('scalar:')) {
    const [, on, field] = spec.split(':');
    if (on === 'source') {
      const v = await sourceScalar(connection.sourceObject, sourceRecordId, field, client);
      return v ? [v] : [];
    }
    return targetsByScalar(connection.targetObject, field, sourceRecordId, client);
  }
  // association mode
  const relations = await getRelations(sourceRecordId, spec, client);
  return fromRelations(relations, connection.targetObject, sourceRecordId);
}
