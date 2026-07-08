// lib/dedup/scan.ts — build comparable keys + find duplicate groups (pure).

import { BusinessListItem } from '../ghl/types';
import { CompanyKey, DedupScanReport, DuplicateGroup } from './types';
import { normalizeLaraId, normalizeName } from './normalize';

/** Pull the lara_id out of a legacy list item's customFields ([{key,valueNumber|valueString}]). */
export function extractLaraId(item: BusinessListItem): string | null {
  for (const cf of item.customFields ?? []) {
    if (cf.key === 'lara_id' || cf.key === 'business.lara_id') {
      const v = cf.valueNumber ?? cf.valueString ?? cf.value;
      const norm = normalizeLaraId(v);
      if (norm) return norm;
    }
  }
  return null;
}

export function toCompanyKey(item: BusinessListItem): CompanyKey {
  return {
    id: item.id,
    name: item.name,
    laraId: extractLaraId(item),
    normName: normalizeName(item.name),
  };
}

/** Group companies into duplicate sets. LARA-id matches are safe to merge; name-only
 *  matches are flagged for human review (variant spellings, franchises, etc.). */
export function scanDuplicates(companies: CompanyKey[]): DedupScanReport {
  const byLara = new Map<string, CompanyKey[]>();
  const byName = new Map<string, CompanyKey[]>();
  let withLaraId = 0;

  for (const c of companies) {
    if (c.laraId) {
      withLaraId++;
      const g = byLara.get(c.laraId) ?? [];
      g.push(c);
      byLara.set(c.laraId, g);
    }
    if (c.normName) {
      const g = byName.get(c.normName) ?? [];
      g.push(c);
      byName.set(c.normName, g);
    }
  }

  const exactDuplicates: DuplicateGroup[] = [];
  const inExactDup = new Set<string>();
  for (const [key, group] of Array.from(byLara.entries())) {
    if (group.length > 1) {
      exactDuplicates.push({
        keyType: 'lara', key,
        companies: group.map((g) => ({ id: g.id, name: g.name })),
        action: 'merge',
      });
      group.forEach((g) => inExactDup.add(g.id));
    }
  }

  const nameCandidates: DuplicateGroup[] = [];
  for (const [key, group] of Array.from(byName.entries())) {
    if (group.length < 2) continue;
    // Skip if every member is already captured as an exact-lara duplicate.
    if (group.every((g) => inExactDup.has(g.id))) continue;
    nameCandidates.push({
      keyType: 'name', key,
      companies: group.map((g) => ({ id: g.id, name: g.name })),
      action: 'review',
    });
  }

  return {
    totalCompanies: companies.length,
    withLaraId,
    missingLaraId: companies.length - withLaraId,
    exactDuplicates,
    nameCandidates,
  };
}
