// lib/mapping/suggest.ts — propose contact<->company field pairings from the live catalogs.
//
// This is what powers "the app pulls both field lists and lets Zach set associations":
// we auto-pair fields that clearly correspond (same bare key, else same normalized name),
// producing a draft mapping table for a human to curate. Suggestions are conservative —
// direction 'both', mirrorDown false — because the human decides the sync policy.

import type { CustomFieldCatalog } from '../ghl/types';
import type { FieldMapping } from './types';

/** Company-name pair is always relevant: legacy contact.companyName mirrors company name. */
const COMPANY_NAME_PAIR: FieldMapping = {
  contactKey: 'companyName',
  businessKey: 'name',
  direction: 'down',
  mirrorDown: true,
  note: 'Legacy free-text Company Name box; Primary Company association does NOT fill it.',
};

function bareKey(fieldKey: string): string {
  return fieldKey.replace(/^contact\./, '').replace(/^business\./, '');
}

function normalizeName(s: string | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Produce a draft mapping set. `keyMatch` pairs win over `nameMatch` pairs; each
 * contact/business field is used at most once.
 */
export function suggestMappings(
  contactCatalog: CustomFieldCatalog,
  businessCatalog: CustomFieldCatalog,
): FieldMapping[] {
  const businessByBare = new Map<string, string>(); // bare -> fieldKey
  const businessByName = new Map<string, string>(); // normName -> fieldKey
  for (const f of businessCatalog.fields) {
    if (!f.fieldKey) continue;
    businessByBare.set(bareKey(f.fieldKey), f.fieldKey);
    const n = normalizeName(f.name);
    if (n && !businessByName.has(n)) businessByName.set(n, f.fieldKey);
  }

  const out: FieldMapping[] = [COMPANY_NAME_PAIR];
  const usedBusiness = new Set<string>(['business.name']);

  const addPair = (contactKey: string, businessKey: string, via: string) => {
    if (usedBusiness.has(businessKey)) return;
    usedBusiness.add(businessKey);
    out.push({
      contactKey,
      businessKey,
      direction: 'both',
      mirrorDown: false,
      note: `auto-suggested (${via})`,
    });
  };

  // Pass 1: exact bare-key match (highest confidence).
  for (const f of contactCatalog.fields) {
    if (!f.fieldKey) continue;
    const bk = businessByBare.get(bareKey(f.fieldKey));
    if (bk && !usedBusiness.has(bk)) addPair(f.fieldKey, bk, 'key');
  }
  // Pass 2: normalized-name match for contact fields still unpaired.
  const pairedContacts = new Set(out.map((m) => m.contactKey));
  for (const f of contactCatalog.fields) {
    if (!f.fieldKey || pairedContacts.has(f.fieldKey)) continue;
    const bk = businessByName.get(normalizeName(f.name));
    if (bk && !usedBusiness.has(bk)) addPair(f.fieldKey, bk, 'name');
  }

  return out;
}
