// lib/enrichment/contactEngine.ts — run contact-targeted enrichers and apply proposals.
//
// The company enrichment engine (engine.ts) writes company fields; this is its contact twin.
// Same shape: run enrichers → dedupe proposals → apply under a policy (fill-empty vs overwrite,
// min-confidence) with an idempotency guard, writing via the object-agnostic writeRecordFields.
// Built for the readiness-tagger (AI-classified service tags → derived stop fields on a contact).

import { GhlClient, ghl } from '../ghl/client';
import { getContact } from '../ghl/contacts';
import { writeRecordFields } from '../ghl/writeRecord';
import type { Contact, CustomFieldCatalog } from '../ghl/types';
import { logEnrichment } from '../audit/log';
import {
  ContactEnricher,
  ContactEnricherInput,
  ContactEnrichmentProposal,
  ContactEnrichmentResult,
  AppliedContactField,
  ApplyPolicy,
} from './types';

/** GHL contact standard scalars readable by key (mirrors lib/wix-sync resolveContactField). */
function contactScalars(contact: Contact): Record<string, unknown> {
  return {
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
}

/** Read a source field value (standard scalar or custom field) off a GHL contact by key. */
export function readContactField(contact: Contact, catalog: CustomFieldCatalog, key: string): unknown {
  const scalars = contactScalars(contact);
  if (key in scalars) return scalars[key];
  const def = catalog.byKey[key] ?? catalog.byId[key];
  if (!def) return undefined;
  return (contact.customFields ?? []).find((f) => f.id === def.id)?.value;
}

/** Normalize a value for equality comparison (arrays order-insensitive, strings case-insensitive). */
function normForCompare(v: unknown): unknown {
  if (Array.isArray(v)) return [...v].map((x) => String(x).trim().toLowerCase()).sort();
  if (v == null) return '';
  return String(v).trim().toLowerCase();
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normForCompare(a)) === JSON.stringify(normForCompare(b));
}

const isEmpty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

/** Dedupe proposals by field, keeping the highest-confidence one. */
function dedupe(proposals: ContactEnrichmentProposal[]): ContactEnrichmentProposal[] {
  const best = new Map<string, ContactEnrichmentProposal>();
  for (const p of proposals) {
    const cur = best.get(p.contactKey);
    if (!cur || p.provenance.confidence > cur.provenance.confidence) best.set(p.contactKey, p);
  }
  return Array.from(best.values());
}

/** Run contact enrichers, returning deduped proposals (no writes). One failing enricher is skipped. */
export async function runContactEnrichers(
  contact: Contact,
  catalog: CustomFieldCatalog,
  enrichers: ContactEnricher[],
): Promise<ContactEnrichmentProposal[]> {
  const input: ContactEnricherInput = {
    contact,
    contactCatalog: catalog,
    field: (key) => readContactField(contact, catalog, key),
  };
  const all: ContactEnrichmentProposal[] = [];
  for (const e of enrichers) {
    try {
      all.push(...(await e.enrich(input)));
    } catch {
      /* one enricher failing must not abort the rest */
    }
  }
  return dedupe(all);
}

/** Decide which proposals to write under the policy, then write them (contact target). */
export async function applyContactProposals(
  contactId: string,
  contact: Contact,
  proposals: ContactEnrichmentProposal[],
  catalog: CustomFieldCatalog,
  policy: ApplyPolicy,
  opts: { apply: boolean; client?: GhlClient } = { apply: false },
): Promise<ContactEnrichmentResult> {
  const minConf = policy.minConfidence ?? 0;
  const applied: AppliedContactField[] = [];
  const skipped: ContactEnrichmentResult['skipped'] = [];
  const changes: Record<string, unknown> = {};

  for (const p of proposals) {
    if (p.provenance.confidence < minConf) {
      skipped.push({ contactKey: p.contactKey, reason: `below min confidence (${p.provenance.confidence})` });
      continue;
    }
    const def = catalog.byKey[p.contactKey] ?? catalog.byId[p.contactKey];
    const isScalar = p.contactKey in contactScalars(contact);
    if (!def && !isScalar) {
      skipped.push({ contactKey: p.contactKey, reason: 'field not in contact catalog' });
      continue;
    }

    const current = readContactField(contact, catalog, p.contactKey);
    if (policy.mode === 'fill-empty' && !isEmpty(current)) {
      skipped.push({ contactKey: p.contactKey, reason: 'already set (fill-empty)' });
      continue;
    }
    // Idempotency guard (in overwrite mode too): don't rewrite an unchanged value.
    if (!isEmpty(current) && valuesEqual(current, p.value)) {
      skipped.push({ contactKey: p.contactKey, reason: 'already up to date' });
      continue;
    }
    if (isEmpty(p.value)) {
      skipped.push({ contactKey: p.contactKey, reason: 'proposed value empty' });
      continue;
    }
    changes[p.contactKey] = p.value;
    applied.push({ contactKey: p.contactKey, value: p.value, provenance: p.provenance });
  }

  let didWrite = false;
  if (opts.apply && Object.keys(changes).length > 0) {
    const client = opts.client ?? ghl();
    await writeRecordFields('contact', contactId, changes, catalog, client);
    didWrite = true;
  }

  return { contactId, proposals, applied, skipped, didWrite };
}

/** End-to-end: read contact, run enrichers, apply under policy. */
export async function enrichContact(
  contactId: string,
  enrichers: ContactEnricher[],
  catalog: CustomFieldCatalog,
  policy: ApplyPolicy,
  opts: { apply: boolean; client?: GhlClient } = { apply: false },
): Promise<ContactEnrichmentResult> {
  const client = opts.client ?? ghl();
  const contact = await getContact(contactId, client);
  if (!contact) throw new Error(`Contact ${contactId} not found`);
  const proposals = await runContactEnrichers(contact, catalog, enrichers);
  const result = await applyContactProposals(contactId, contact, proposals, catalog, policy, opts);
  if (opts.apply && result.applied.length) {
    await logEnrichment({
      objectType: 'contact', recordId: contactId,
      recordLabel: [contact.firstName, contact.lastName].filter(Boolean).join(' '),
      actorName: 'contact-enrichers', applyMode: opts.apply,
      applied: result.applied.map((a) => ({ key: a.contactKey, value: a.value, provenance: a.provenance })),
    });
  }
  return result;
}
