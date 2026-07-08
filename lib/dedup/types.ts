// lib/dedup/types.ts — app-layer dedup shapes.
//
// The system Company object can't enforce a unique lara_id (uniqueProperties rejected),
// so dedup is app-owned: match-or-create by LARA ID before inserting, plus a periodic
// duplicate scan. LARA ID is the authoritative key; normalized name is a weak fallback
// that is only ever FLAGGED for human review, never auto-merged.

export interface CompanyKey {
  id: string;
  name: string;
  /** normalized lara id, or null if the company has none. */
  laraId: string | null;
  /** normalized name (for the weak fallback grouping). */
  normName: string;
}

export type DuplicateKeyType = 'lara' | 'name';

export interface DuplicateGroup {
  keyType: DuplicateKeyType;
  /** the shared normalized key (lara id or normalized name). */
  key: string;
  companies: Array<{ id: string; name: string }>;
  /** 'merge' = safe to merge (same LARA ID); 'review' = human decision needed. */
  action: 'merge' | 'review';
}

export interface DedupScanReport {
  totalCompanies: number;
  withLaraId: number;
  missingLaraId: number;
  /** same LARA ID on >1 company — true duplicates, safe to merge. */
  exactDuplicates: DuplicateGroup[];
  /** same normalized name (and not already an exact-lara dup) — flag for review. */
  nameCandidates: DuplicateGroup[];
}

export type MatchStatus = 'matched' | 'created' | 'ambiguous' | 'no-key';

export interface MatchResult {
  status: MatchStatus;
  companyId?: string;
  laraId: string | null;
  /** for 'ambiguous': the candidate company ids that matched on a weak key. */
  candidates?: string[];
  note?: string;
}
