// lib/dedup/engine.ts — dedup IO: index, match-or-create, merge.

import { GhlClient, ghl } from '../ghl/client';
import { CustomFieldCatalog } from '../ghl/types';
import { isUnwritable, isCreateOnly } from '../ghl/coerce';
import { listAllBusinesses, getBusinessRecord, setBusinessFields, deleteBusiness } from '../ghl/businesses';
import { listContactsByBusiness, setContactBusiness } from '../ghl/contacts';
import { CompanyKey, MatchResult, DedupScanReport } from './types';
import { toCompanyKey, scanDuplicates } from './scan';
import { normalizeLaraId, normalizeName } from './normalize';

export interface CompanyIndex {
  keys: CompanyKey[];
  byLara: Map<string, string[]>;
  byName: Map<string, string[]>;
}

/** One cheap paginated pass over /businesses/ (lara_id rides in the list customFields). */
export async function loadCompanyIndex(client: GhlClient = ghl()): Promise<CompanyIndex> {
  const items = await listAllBusinesses(client);
  const keys = items.map(toCompanyKey);
  const byLara = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  for (const k of keys) {
    if (k.laraId) byLara.set(k.laraId, [...(byLara.get(k.laraId) ?? []), k.id]);
    if (k.normName) byName.set(k.normName, [...(byName.get(k.normName) ?? []), k.id]);
  }
  return { keys, byLara, byName };
}

export function scanIndex(index: CompanyIndex): DedupScanReport {
  return scanDuplicates(index.keys);
}

/**
 * Match-or-create by LARA id (the authoritative key). No LARA id falls back to a
 * name check that is FLAGGED, never silently merged.
 *   - lara id + hit      -> matched (first id; note if >1 share it = existing dup)
 *   - lara id + no hit   -> created
 *   - no lara + name hit -> ambiguous (does NOT create; human decides)
 *   - no lara + no hit   -> created (flagged: created without a dedup key)
 */
export async function createOrMatchByLaraId(
  input: { laraId?: unknown; name: string; create: () => Promise<string> },
  index: CompanyIndex,
): Promise<MatchResult> {
  const lara = normalizeLaraId(input.laraId);
  if (lara) {
    const hits = index.byLara.get(lara);
    if (hits && hits.length) {
      return { status: 'matched', companyId: hits[0], laraId: lara, candidates: hits.length > 1 ? hits : undefined, note: hits.length > 1 ? `${hits.length} existing companies share this LARA id` : undefined };
    }
    const id = await input.create();
    return { status: 'created', companyId: id, laraId: lara };
  }
  const nn = normalizeName(input.name);
  const nameHits = nn ? index.byName.get(nn) : undefined;
  if (nameHits && nameHits.length) {
    return { status: 'ambiguous', laraId: null, candidates: nameHits, note: 'No LARA id; name matches existing company/companies — review before create/merge.' };
  }
  const id = await input.create();
  return { status: 'created', companyId: id, laraId: null, note: 'Created without a LARA id (no dedup key) — flag for later LARA lookup.' };
}

export interface MergePlan {
  survivorId: string;
  loserId: string;
  contactsToMove: string[];
  fieldsToCopy: Record<string, unknown>;
  skippedFields: Array<{ key: string; reason: string }>;
  applied: boolean;
}

/**
 * Merge loser into survivor: move loser's contacts, copy loser's non-empty firmographics
 * into survivor's EMPTY fields only, delete loser. Opt-in (apply). Create-only/unwritable
 * fields (e.g. multi-select) can't be copied via update -> skipped with a reason.
 */
export async function mergeCompanies(
  survivorId: string,
  loserId: string,
  businessCatalog: CustomFieldCatalog,
  opts: { apply: boolean; client?: GhlClient } = { apply: false },
): Promise<MergePlan> {
  const client = opts.client ?? ghl();
  const [survivor, loser] = await Promise.all([
    getBusinessRecord(survivorId, client),
    getBusinessRecord(loserId, client),
  ]);
  if (!survivor || !loser) throw new Error('survivor or loser company not found');

  const fieldsToCopy: Record<string, unknown> = {};
  const skippedFields: MergePlan['skippedFields'] = [];
  for (const [bareKey, loserVal] of Object.entries(loser.properties)) {
    if (bareKey === 'name') continue;
    if (loserVal == null || loserVal === '') continue;
    const survVal = survivor.properties[bareKey];
    if (survVal != null && survVal !== '') continue; // only fill survivor's empties
    const def = businessCatalog.byKey[`business.${bareKey}`];
    if (def && (isUnwritable(def.dataType) || isCreateOnly(def.dataType))) {
      skippedFields.push({ key: bareKey, reason: `${def.dataType} not writable via update` });
      continue;
    }
    fieldsToCopy[bareKey] = loserVal;
  }

  const loserContacts = await listContactsByBusiness(loserId, client);
  const contactsToMove = loserContacts.map((c) => c.id);

  if (opts.apply) {
    for (const cid of contactsToMove) await setContactBusiness(cid, survivorId, client);
    if (Object.keys(fieldsToCopy).length) await setBusinessFields(survivorId, fieldsToCopy, businessCatalog.byKey, client);
    await deleteBusiness(loserId, client);
  }

  return { survivorId, loserId, contactsToMove, fieldsToCopy, skippedFields, applied: opts.apply };
}
