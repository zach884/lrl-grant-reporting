// lib/ghl/resourceRelations.ts — guarantee the company↔resource link the "Become a Resource" form
// can't make itself.
//
// Verified 2026-08-17: the reworked form matches the submitting contact by email and creates the
// CONTACT↔resource relation itself (0.3s after the record), but it has no notion of the business
// object, so the COMPANY↔resource relation is never created. Per Zach the company link matters more
// for resources (it's what makes them joinable to companies for reporting), so the pipeline
// guarantees it deterministically:
//
//   1. the matched contact's `businessId` — already populated by the form's contact match. Primary
//      path, needs no name matching.
//   2. no businessId -> match the company by NAME against the dedup index. Exactly one hit links;
//      anything else is surfaced for review.
//   3. nothing -> leave it unlinked and report `needs-review`. We never invent a company: writing
//      company fields from form data creates a new company per submission (see the
//      ghl-company-object-api-facts memory), and a name-only match is `ambiguous` by the dedup
//      engine's own rule — never silently merged.
//
// Confidence check: the resource and company website domains are compared. Disagreement still
// links (Zach: easy to fix by hand) but is FLAGGED, because the realistic failure mode is an
// EDC/partner staffer submitting a resource on behalf of a different organization.

import { GhlClient, ghl } from './client';
import { createRelation, getRelations } from './associations';
import { getContact } from './contacts';
import { readRecordFields } from './records';
import { normalizeName } from '../dedup/normalize';

/** Association definitions on the live location (both created 2026-08-17). */
export const RESOURCE_CONTACT_ASSOCIATION_ID = '6a7a0a401b4a19424298a73d';
export const RESOURCE_COMPANY_ASSOCIATION_ID = '6a7a0a1d62d53d4b44142023';

export const RESOURCES_OBJECT = 'custom_objects.resources';

export interface ResourceCompanyLinkResult {
  status: 'already-linked' | 'linked' | 'needs-review' | 'error';
  companyId?: string;
  contactId?: string;
  /** How the company was determined. */
  via?: 'contact-businessId' | 'company-name';
  /** Set when the resource's website domain disagrees with the company's — link kept, but flagged. */
  domainMismatch?: { resource: string; company: string };
  note?: string;
  applied: boolean;
}

/** Bare host, lowercased, `www.` stripped — for the confidence check only. */
export function websiteDomain(value: unknown): string | null {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** True when both domains are known AND differ. Unknown on either side is not a mismatch. */
export function domainsDisagree(a: unknown, b: unknown): boolean {
  const da = websiteDomain(a);
  const db = websiteDomain(b);
  return !!da && !!db && da !== db;
}

/** The relation record on `resource` pointing at a company, if the API returned one. */
function findCompanyRelation(relations: any[], resourceId: string): string | null {
  for (const r of relations) {
    const isCompanyAssoc =
      r.associationId === RESOURCE_COMPANY_ASSOCIATION_ID ||
      r.firstObjectKey === 'business' ||
      r.secondObjectKey === 'business';
    if (!isCompanyAssoc) continue;
    const other = r.firstRecordId === resourceId ? r.secondRecordId : r.firstRecordId;
    if (other) return String(other);
  }
  return null;
}

/** The contact linked to this resource (created by the form), if any. */
function findContactRelation(relations: any[], resourceId: string): string | null {
  for (const r of relations) {
    const isContactAssoc =
      r.associationId === RESOURCE_CONTACT_ASSOCIATION_ID ||
      r.firstObjectKey === 'contact' ||
      r.secondObjectKey === 'contact';
    if (!isContactAssoc) continue;
    const other = r.firstRecordId === resourceId ? r.secondRecordId : r.firstRecordId;
    if (other) return String(other);
  }
  return null;
}

/** A duplicate-relation error means someone/something already made the link — treat as success. */
function isAlreadyExists(e: any): boolean {
  const msg = String(e?.message ?? e).toLowerCase();
  return msg.includes('already exist') || msg.includes('duplicate') || e?.status === 409;
}

/**
 * Ensure the resource record is linked to a company. Idempotent: an existing link short-circuits,
 * and a duplicate-relation error is treated as already-linked (the relations read is documented as
 * unreliable for records with mixed link types, so we cannot fully trust "absent").
 *
 * Nothing is written unless `apply` is true — a dry run reports exactly what it would link.
 */
export async function ensureResourceCompanyLink(
  resourceId: string,
  opts: { apply: boolean; client?: GhlClient },
): Promise<ResourceCompanyLinkResult> {
  const client = opts.client ?? ghl();

  let relations: any[] = [];
  try {
    relations = await getRelations(resourceId, '', client);
  } catch (e: any) {
    return { status: 'error', applied: false, note: `could not read relations: ${e?.message ?? e}` };
  }

  const existingCompany = findCompanyRelation(relations, resourceId);
  if (existingCompany) {
    return { status: 'already-linked', companyId: existingCompany, applied: false };
  }

  const contactId = findContactRelation(relations, resourceId);

  // Resource website, for the confidence check.
  let resourceWebsite: unknown;
  try {
    const fields = await readRecordFields(RESOURCES_OBJECT, resourceId, client);
    resourceWebsite = fields.get(`${RESOURCES_OBJECT}.website`) ?? fields.get('website');
  } catch {
    /* the confidence check is a nice-to-have, never a blocker */
  }

  // --- path 1: the matched contact's businessId ---
  let companyId: string | null = null;
  let via: ResourceCompanyLinkResult['via'] | undefined;
  let companyName: string | undefined;

  if (contactId) {
    const contact = await getContact(contactId, client);
    if (contact?.businessId) {
      companyId = String(contact.businessId);
      via = 'contact-businessId';
    } else if (contact?.companyName) {
      companyName = String(contact.companyName);
    }
  }

  // --- path 2: match an existing company by name (never create) ---
  if (!companyId && companyName) {
    const { loadCompanyIndex } = await import('../dedup/engine');
    const index = await loadCompanyIndex(client);
    const hits = index.byName.get(normalizeName(companyName)) ?? [];
    if (hits.length === 1) {
      companyId = hits[0];
      via = 'company-name';
    } else {
      return {
        status: 'needs-review',
        contactId: contactId ?? undefined,
        applied: false,
        note:
          hits.length === 0
            ? `contact has no businessId and no company named "${companyName}" exists — link by hand or create the company first`
            : `company name "${companyName}" matches ${hits.length} companies — ambiguous, link by hand`,
      };
    }
  }

  if (!companyId) {
    return {
      status: 'needs-review',
      contactId: contactId ?? undefined,
      applied: false,
      note: contactId
        ? 'linked contact has no businessId and no company name to match on'
        : 'no contact relation on this resource — cannot derive a company',
    };
  }

  // Confidence check (never blocks).
  let domainMismatch: ResourceCompanyLinkResult['domainMismatch'];
  try {
    const companyFields = await readRecordFields('business', companyId, client);
    const companyWebsite = companyFields.get('business.website') ?? companyFields.get('website');
    if (domainsDisagree(resourceWebsite, companyWebsite)) {
      domainMismatch = {
        resource: websiteDomain(resourceWebsite) ?? '',
        company: websiteDomain(companyWebsite) ?? '',
      };
    }
  } catch {
    /* ignore */
  }

  if (!opts.apply) {
    return { status: 'linked', companyId, contactId: contactId ?? undefined, via, domainMismatch, applied: false };
  }

  try {
    // Business FIRST, resource SECOND — the association's declared order.
    await createRelation(
      { associationId: RESOURCE_COMPANY_ASSOCIATION_ID, firstRecordId: companyId, secondRecordId: resourceId },
      client,
    );
  } catch (e: any) {
    if (isAlreadyExists(e)) {
      return { status: 'already-linked', companyId, contactId: contactId ?? undefined, applied: false };
    }
    return {
      status: 'error',
      companyId,
      contactId: contactId ?? undefined,
      via,
      applied: false,
      note: `relation create failed: ${e?.message ?? e}`,
    };
  }

  return { status: 'linked', companyId, contactId: contactId ?? undefined, via, domainMismatch, applied: true };
}
