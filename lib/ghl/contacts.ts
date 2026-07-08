// lib/ghl/contacts.ts — contact operations.
//
// Enumeration (confirmed live): the ONLY reliable way to page ALL contacts is legacy
//   GET /contacts/?locationId=&limit=100  then follow meta.nextPageUrl, WITH per-page
//   retry (GHL emits transient empty pages that otherwise truncate the run).
//   POST /contacts/search caps out ~1200 and its searchAfter paging is finicky.
// Company link is the scalar `businessId` (NOT companyId) via PUT /contacts/{id}.

import { GhlClient, ghl } from './client';
import { Contact } from './types';

const PAGE = 100;

function mapContact(c: any): Contact {
  return {
    id: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    phone: c.phone,
    companyName: c.companyName,
    // GHL fills `businessId`; some responses echo companyId — prefer businessId.
    businessId: c.businessId ?? c.companyId,
    city: c.city,
    state: c.state,
    postalCode: c.postalCode,
    customFields: c.customFields,
  };
}

/** Type-ahead search (existing UI picker uses this). */
export async function searchContacts(
  query: string,
  limit = 10,
  client: GhlClient = ghl(),
): Promise<Contact[]> {
  const data = await client.request<any>({
    path: '/contacts/',
    params: { query, limit },
  });
  return (data.contacts ?? []).map(mapContact);
}

export async function getContact(contactId: string, client: GhlClient = ghl()): Promise<Contact | null> {
  const data = await client.request<any>({ path: `/contacts/${contactId}`, autoLocation: false });
  const c = data.contact ?? data;
  return c && c.id ? mapContact(c) : null;
}

/**
 * Enumerate ALL contacts reliably (legacy list + nextPageUrl + retry).
 * `onPage` lets callers stream instead of buffering ~1500 records in memory.
 */
export async function enumerateAllContacts(
  client: GhlClient = ghl(),
  onPage?: (batch: Contact[]) => void,
): Promise<Contact[]> {
  const out: Contact[] = [];
  let url: string | undefined = undefined;
  let first = true;
  for (;;) {
    const data: any = first
      ? await client.request<any>({ path: '/contacts/', params: { limit: PAGE } })
      : await client.request<any>({ path: url as string, autoLocation: false });
    first = false;
    const batch: Contact[] = (data.contacts ?? []).map(mapContact);
    if (batch.length === 0) break;
    if (onPage) onPage(batch);
    else out.push(...batch);
    const next: string | undefined = data.meta?.nextPageUrl;
    if (!next) break;
    url = next;
  }
  return out;
}

/** Contacts associated with a company. Reliable path = filter the full enumeration. */
export async function listContactsByBusiness(
  businessId: string,
  client: GhlClient = ghl(),
): Promise<Contact[]> {
  const all = await enumerateAllContacts(client);
  return all.filter((c) => c.businessId === businessId);
}

/** Set the contact's legacy free-text Company Name box (what legacy reports read). */
export async function setContactCompanyName(
  contactId: string,
  companyName: string,
  client: GhlClient = ghl(),
): Promise<void> {
  await client.request({
    method: 'PUT',
    path: `/contacts/${contactId}`,
    autoLocation: false,
    body: { companyName },
  });
}

/** Associate a contact with a company (writes the `businessId` scalar). */
export async function setContactBusiness(
  contactId: string,
  businessId: string,
  client: GhlClient = ghl(),
): Promise<void> {
  await client.request({
    method: 'PUT',
    path: `/contacts/${contactId}`,
    autoLocation: false,
    body: { businessId },
  });
}

/** Write contact custom-field values (keyed by field id: [{ id, value }]). */
export async function setContactCustomFields(
  contactId: string,
  fields: Array<{ id: string; value: unknown }>,
  client: GhlClient = ghl(),
): Promise<void> {
  await client.request({
    method: 'PUT',
    path: `/contacts/${contactId}`,
    autoLocation: false,
    body: { customFields: fields },
  });
}
