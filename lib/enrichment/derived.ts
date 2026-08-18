// lib/enrichment/derived.ts — DERIVED fields: rewrite only when their drivers actually change.
//
// PURE. Some enricher outputs are free-text restatements of a structured result — the readiness
// taggers' `readiness_rationale` is one line of LLM prose explaining the service tags. The prose
// varies between runs even when the tags are byte-identical, so an ordinary equality guard always
// sees a diff and always writes. Measured 2026-08-05..08-17: 67 rationale writes, several of them
// the ONLY change in the run, each one propagating to Wix and churning the row's _updatedDate.
//
// Marking such a proposal `derivedFrom: [<driver keys>]` makes it follow its drivers: it is written
// when at least one driver is written, and skipped otherwise. The stored rationale therefore always
// describes the stored tags — which is the actual invariant we want — without the churn.

/**
 * Should a derived field be written this run? Only if at least one of the fields it is derived from
 * is itself being written. An empty/absent driver list means "not derived" -> always write.
 */
export function shouldWriteDerived(
  derivedFrom: string[] | undefined,
  appliedKeys: readonly string[],
): boolean {
  if (!derivedFrom || derivedFrom.length === 0) return true;
  const applied = new Set<string>();
  for (const k of appliedKeys) {
    applied.add(k);
    applied.add(bare(k));
  }
  return derivedFrom.some((k) => applied.has(k) || applied.has(bare(k)));
}

/** Last dotted segment, so 'contact.service_areas' and a bare 'service_areas' compare equal. */
function bare(key: string): string {
  const i = key.lastIndexOf('.');
  return i === -1 ? key : key.slice(i + 1);
}

export const DERIVED_UNCHANGED_REASON = 'derived field; its source fields did not change';
