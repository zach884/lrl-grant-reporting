// lib/sync/downsync.ts — company (source of truth) -> associated contacts.
//
// Native UP-sync (contact -> its company) stays in GHL. This is the APP-owned DOWN-sync
// GHL can't do (fan out to ALL associated contacts). Driven entirely by the curated
// field-mapping table. Idempotent + equality-guarded (writes only real diffs) so it's
// safe to run repeatedly and can't ping-pong with the native up-sync.

import { GhlClient, ghl } from '../ghl/client';
import { BusinessRecord, Contact, CustomFieldCatalog } from '../ghl/types';
import { optionKeyToLabel } from '../ghl/coerce';
import { coerceContactCustomFields } from '../ghl/coerceContact';
import { getBusinessRecord } from '../ghl/businesses';
import {
  getContact,
  listContactsByBusiness,
  setContactCustomFields,
  setContactCompanyName,
} from '../ghl/contacts';
import type { FieldMapping } from '../mapping/types';
import { DesiredContactState, ContactSyncResult, CompanySyncResult } from './types';

const bare = (k: string) => k.replace(/^business\./, '');

function isDown(m: FieldMapping): boolean {
  return m.enabled !== false && (m.direction === 'down' || m.direction === 'both');
}

/** Convert a value AS STORED ON THE COMPANY into the "contact input" form. */
export function businessValueToContactInput(
  businessKey: string,
  rawValue: unknown,
  businessCatalog: CustomFieldCatalog,
): unknown {
  const def = businessCatalog.byKey[businessKey] ?? businessCatalog.byKey[`business.${bare(businessKey)}`];
  if (!def) return rawValue; // scalar (e.g. name)
  if (def.dataType === 'SINGLE_OPTIONS' || def.dataType === 'RADIO') {
    return optionKeyToLabel(rawValue, def.options);
  }
  if (def.dataType === 'MULTIPLE_OPTIONS') {
    const arr = Array.isArray(rawValue) ? rawValue : [rawValue];
    return arr.map((v) => optionKeyToLabel(v, def.options)).filter((v): v is string => !!v);
  }
  return rawValue;
}

/** Read the company record + mapping -> the desired state to mirror onto each contact. */
export function buildDesiredContactState(
  company: BusinessRecord,
  mappings: FieldMapping[],
  businessCatalog: CustomFieldCatalog,
): DesiredContactState {
  const customInputs: Record<string, unknown> = {};
  const holdByContactKey: Record<string, string[]> = {};
  let companyName: string | undefined;

  for (const m of mappings) {
    if (!isDown(m)) continue;
    if (m.holdValues?.length) holdByContactKey[m.contactKey] = m.holdValues;
    // Company name -> legacy contact companyName scalar.
    if (m.businessKey === 'name' && m.contactKey === 'companyName') {
      const v = company.properties['name'];
      if (v != null && v !== '') companyName = String(v);
      continue;
    }
    const raw = company.properties[bare(m.businessKey)];
    if (raw == null || raw === '' || (Array.isArray(raw) && raw.length === 0)) continue;
    const input = businessValueToContactInput(m.businessKey, raw, businessCatalog);
    if (input == null || input === '' || (Array.isArray(input) && input.length === 0)) continue;
    customInputs[m.contactKey] = input;
  }
  return { customInputs, companyName, holdByContactKey };
}

/** Deep-equal with array-order and type tolerance (for the equality guard). */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return (a ?? '') === (b ?? '');
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sa = [...a].map(String).sort();
    const sb = [...b].map(String).sort();
    return sa.every((v, i) => v === sb[i]);
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || !ka.every((k, i) => k === kb[i])) return false;
    return ka.every((k) => valuesEqual((a as any)[k], (b as any)[k]));
  }
  // Number/string coercion (contact numbers can read back as strings).
  return String(a) === String(b);
}

export interface ContactWritePlan {
  changedFields: Array<{ id: string; value: unknown }>;
  companyName?: string; // set only if it differs
  unchanged: number;
  skipped: ContactSyncResult['skipped'];
  drift: ContactSyncResult['drift'];
}

/** Diff the desired state against a contact's current values (equality guard). */
export function planContactWrites(
  desired: DesiredContactState,
  contact: Contact,
  contactCatalog: CustomFieldCatalog,
): ContactWritePlan {
  const { fields, skipped } = coerceContactCustomFields(desired.customInputs, contactCatalog);
  const currentById = new Map<string, unknown>();
  for (const cf of contact.customFields ?? []) currentById.set(cf.id, cf.value);

  // No-downgrade guard: map hold values (by contactKey) to the coerced field id.
  const holdById = new Map<string, Set<string>>();
  for (const [contactKey, vals] of Object.entries(desired.holdByContactKey ?? {})) {
    const id = contactCatalog.byKey[contactKey]?.id;
    if (id) holdById.set(id, new Set(vals.map((v) => v.toLowerCase())));
  }
  const isBlank = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

  const changedFields: ContactWritePlan['changedFields'] = [];
  const drift: ContactWritePlan['drift'] = [];
  let unchanged = 0;
  for (const f of fields) {
    const cur = currentById.get(f.id);
    if (valuesEqual(cur, f.value)) { unchanged++; continue; }
    // Hold: don't overwrite an existing (non-blank) contact value with a hold value.
    const hold = holdById.get(f.id);
    if (hold && !isBlank(cur) && [f.value].flat().every((v) => hold.has(String(v).toLowerCase()))) {
      skipped.push({ key: f.id, value: f.value, reason: `no-downgrade: refused to overwrite ${JSON.stringify(cur)} with hold value` });
      continue;
    }
    changedFields.push(f);
    drift.push({ field: f.id, from: cur, to: f.value });
  }

  let companyName: string | undefined;
  if (desired.companyName !== undefined && !valuesEqual(contact.companyName ?? '', desired.companyName)) {
    companyName = desired.companyName;
    drift.push({ field: 'companyName', from: contact.companyName, to: desired.companyName });
  }

  return { changedFields, companyName, unchanged, skipped, drift };
}

/** Apply (or dry-run) a plan to one contact. */
export async function syncContact(
  desired: DesiredContactState,
  contact: Contact,
  contactCatalog: CustomFieldCatalog,
  opts: { apply: boolean; client?: GhlClient } = { apply: false },
): Promise<ContactSyncResult> {
  const client = opts.client ?? ghl();
  const plan = planContactWrites(desired, contact, contactCatalog);
  const written: string[] = [];

  if (opts.apply) {
    if (plan.changedFields.length > 0) {
      await setContactCustomFields(contact.id, plan.changedFields, client);
      written.push(...plan.changedFields.map((f) => f.id));
    }
    if (plan.companyName !== undefined) {
      await setContactCompanyName(contact.id, plan.companyName, client);
    }
  } else {
    written.push(...plan.changedFields.map((f) => f.id));
  }

  return {
    contactId: contact.id,
    written,
    companyNameWritten: plan.companyName !== undefined,
    unchanged: plan.unchanged,
    skipped: plan.skipped,
    drift: plan.drift,
    applied: opts.apply,
  };
}

/** Full down-sync for one company: fan out to every associated contact. */
export async function syncCompanyDown(
  companyId: string,
  mappings: FieldMapping[],
  catalogs: { business: CustomFieldCatalog; contact: CustomFieldCatalog },
  opts: { apply: boolean; client?: GhlClient; contacts?: Contact[] } = { apply: false },
): Promise<CompanySyncResult> {
  const client = opts.client ?? ghl();
  const company = await getBusinessRecord(companyId, client);
  if (!company) throw new Error(`Company ${companyId} not found`);
  const desired = buildDesiredContactState(company, mappings, catalogs.business);
  const contacts = opts.contacts ?? (await listContactsByBusiness(companyId, client));

  const results: ContactSyncResult[] = [];
  for (const c of contacts) {
    // ALWAYS re-read the full contact: the /contacts/ list + search endpoints return an
    // empty/partial customFields array, so their values can't be trusted for the equality
    // guard (a light record makes every field look "changed" -> breaks idempotency).
    const full = (await getContact(c.id, client)) ?? c;
    results.push(await syncContact(desired, full, catalogs.contact, { apply: opts.apply, client }));
  }
  return {
    companyId,
    companyName: desired.companyName,
    contactCount: contacts.length,
    results,
  };
}
