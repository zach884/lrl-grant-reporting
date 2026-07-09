// lib/sync/upsync.ts — contact (edited) -> its company. The mirror of down-sync.
//
// Real-time path: a contact changes -> push its mapped values UP to the associated
// company (equality-guarded). If the company actually changed, fan OUT down to the
// company's other contacts (via the associations roster). The two equality guards make
// the loop self-terminating (no ping-pong with the native/contact side).
//
// Honors FieldMapping.direction: only 'up' | 'both' rows sync up. Company-side
// create-only (MULTIPLE_OPTIONS) + unwritable fields are skipped (those are handled by
// the native workflow-enroll path, not API update). The company-name field is down-only
// by mapping, so up-sync never renames a company.

import { GhlClient, ghl } from '../ghl/client';
import { BusinessRecord, Contact, CustomFieldCatalog, CustomFieldDef } from '../ghl/types';
import { coerceBusinessProperties, isCreateOnly, isUnwritable, resolveOptionKey } from '../ghl/coerce';
import { getBusinessRecord, setBusinessFields } from '../ghl/businesses';
import { getContact } from '../ghl/contacts';
import { getAssociatedContactIds } from '../ghl/associations';
import type { FieldMapping } from '../mapping/types';
import { valuesEqual, syncCompanyDown } from './downsync';
import { CompanySyncResult } from './types';

const bare = (k: string) => k.replace(/^business\./, '');
const isUp = (m: FieldMapping) => m.enabled !== false && (m.direction === 'up' || m.direction === 'both');

// Contact scalars we can read directly off the contact object (not custom fields).
const CONTACT_SCALARS = new Set(['firstName', 'lastName', 'email', 'phone', 'city', 'state', 'postalCode', 'companyName']);

/** Read a contact's value for a mapping's contactKey (custom field by id, or a scalar). */
export function readContactValue(
  contactKey: string,
  contact: Contact,
  contactCatalog: CustomFieldCatalog,
): unknown {
  const def = contactCatalog.byKey[contactKey];
  if (def) {
    const cf = (contact.customFields ?? []).find((f) => f.id === def.id);
    return cf?.value;
  }
  if (CONTACT_SCALARS.has(contactKey)) return (contact as any)[contactKey];
  return undefined;
}

export interface DesiredCompanyState {
  /** bareKey -> value (pre-coercion, contact-form). */
  inputs: Record<string, unknown>;
  skipped: Array<{ key: string; reason: string }>;
}

/** Build the company-side values a contact edit should push up. */
export function buildDesiredCompanyState(
  contact: Contact,
  mappings: FieldMapping[],
  contactCatalog: CustomFieldCatalog,
  businessCatalog: CustomFieldCatalog,
): DesiredCompanyState {
  const inputs: Record<string, unknown> = {};
  const skipped: DesiredCompanyState['skipped'] = [];
  for (const m of mappings) {
    if (!isUp(m)) continue;
    const bKey = bare(m.businessKey);
    const def = businessCatalog.byKey[m.businessKey] ?? businessCatalog.byKey[`business.${bKey}`];
    if (!def) { skipped.push({ key: m.businessKey, reason: 'company field not in catalog' }); continue; }
    if (isUnwritable(def.dataType)) { skipped.push({ key: bKey, reason: `unwritable ${def.dataType}` }); continue; }
    if (isCreateOnly(def.dataType)) { skipped.push({ key: bKey, reason: `create-only ${def.dataType} (workflow-enroll path)` }); continue; }
    const v = readContactValue(m.contactKey, contact, contactCatalog);
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    inputs[bKey] = v;
  }
  return { inputs, skipped };
}

export interface CompanyWritePlan {
  changed: Record<string, unknown>;
  unchanged: number;
  skipped: Array<{ key: string; value?: unknown; reason: string }>;
  drift: Array<{ field: string; from: unknown; to: unknown }>;
}

/**
 * Field-aware equality: the company STORES single-selects as option KEYS and dates as
 * YYYY-MM-DD, while the coerced write value is a LABEL / full-ISO. Compare in the stored
 * form so the guard doesn't rewrite every run.
 */
function companyValueEqual(def: CustomFieldDef | undefined, current: unknown, coercedWrite: unknown): boolean {
  const dt = def?.dataType;
  if (dt === 'SINGLE_OPTIONS' || dt === 'RADIO') {
    return resolveOptionKey(current, def?.options) === resolveOptionKey(coercedWrite, def?.options);
  }
  if (dt === 'DATE') {
    return String(current ?? '').slice(0, 10) === String(coercedWrite ?? '').slice(0, 10);
  }
  return valuesEqual(current, coercedWrite);
}

/** Coerce + equality-guard the desired company state against the current record. */
export function planCompanyWrites(
  desired: DesiredCompanyState,
  company: BusinessRecord,
  businessCatalog: CustomFieldCatalog,
): CompanyWritePlan {
  const coerced = coerceBusinessProperties(desired.inputs, businessCatalog.byKey, 'update');
  const changed: Record<string, unknown> = {};
  const drift: CompanyWritePlan['drift'] = [];
  let unchanged = 0;
  for (const [bareKey, value] of Object.entries(coerced.properties)) {
    const def = businessCatalog.byKey[`business.${bareKey}`] ?? businessCatalog.byKey[bareKey];
    const cur = company.properties[bareKey];
    if (companyValueEqual(def, cur, value)) { unchanged++; continue; }
    changed[bareKey] = value;
    drift.push({ field: bareKey, from: cur, to: value });
  }
  return { changed, unchanged, skipped: [...desired.skipped, ...coerced.skipped], drift };
}

export interface ContactUpResult {
  contactId: string;
  companyId?: string;
  written: string[];
  unchanged: number;
  skipped: CompanyWritePlan['skipped'];
  drift: CompanyWritePlan['drift'];
  companyChanged: boolean;
  applied: boolean;
  note?: string;
}

/** Push one contact's mapped values up to its company (equality-guarded). */
export async function syncContactUp(
  contactId: string,
  mappings: FieldMapping[],
  catalogs: { business: CustomFieldCatalog; contact: CustomFieldCatalog },
  opts: { apply: boolean; client?: GhlClient; contact?: Contact } = { apply: false },
): Promise<ContactUpResult> {
  const client = opts.client ?? ghl();
  const contact = opts.contact ?? (await getContact(contactId, client));
  const base: ContactUpResult = { contactId, written: [], unchanged: 0, skipped: [], drift: [], companyChanged: false, applied: opts.apply };
  if (!contact) return { ...base, note: 'contact not found' };
  if (!contact.businessId) return { ...base, note: 'contact has no associated company' };

  const company = await getBusinessRecord(contact.businessId, client);
  if (!company) return { ...base, companyId: contact.businessId, note: 'company not found' };

  const desired = buildDesiredCompanyState(contact, mappings, catalogs.contact, catalogs.business);
  const plan = planCompanyWrites(desired, company, catalogs.business);
  const written = Object.keys(plan.changed);

  if (opts.apply && written.length > 0) {
    await setBusinessFields(contact.businessId, plan.changed, catalogs.business.byKey, client);
  }
  return {
    contactId,
    companyId: contact.businessId,
    written,
    unchanged: plan.unchanged,
    skipped: plan.skipped,
    drift: plan.drift,
    companyChanged: written.length > 0,
    applied: opts.apply,
  };
}

export interface UpAndFanOutResult {
  up: ContactUpResult;
  down?: CompanySyncResult;
}

/**
 * The real-time webhook action: up-sync the contact, and IF the company changed, fan the
 * new company state down to its OTHER contacts (roster from the associations graph). The
 * down-fan-out is equality-guarded, so the triggering contact is a no-op and it can't loop.
 */
export async function syncContactUpAndFanOut(
  contactId: string,
  mappings: FieldMapping[],
  catalogs: { business: CustomFieldCatalog; contact: CustomFieldCatalog },
  opts: { apply: boolean; client?: GhlClient } = { apply: false },
): Promise<UpAndFanOutResult> {
  const client = opts.client ?? ghl();
  const up = await syncContactUp(contactId, mappings, catalogs, { apply: opts.apply, client });
  if (!up.companyChanged || !up.companyId) return { up };

  const ids = await getAssociatedContactIds(up.companyId, client);
  const roster: Contact[] = ids.map((id) => ({ id }));
  const down = await syncCompanyDown(up.companyId, mappings, catalogs, { apply: opts.apply, client, contacts: roster });
  return { up, down };
}
