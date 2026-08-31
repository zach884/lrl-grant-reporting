// lib/sync/identityGuard.ts — "is this contact still at the company we're about to write to?"
//
// WHY THIS EXISTS. The contact→company push takes its VALUES from the contact but decides WHERE to
// write from `contact.businessId`. Those two facts can disagree: when someone changes employer, GHL
// updates their `companyName` long before (or without) re-pointing `businessId`. The sync then
// happily writes the NEW employer's name, website, address, revenue, headcount and demographics over
// the OLD company's record — 39 mapped fields, silently, and the result looks like a legitimate
// update in every log.
//
// So before writing, compare the identity the CONTACT claims against the identity of the company the
// link points at, and refuse to write when the evidence says they are different companies. A refusal
// is a REVIEW ITEM, never a silent skip: someone has to re-point the association.
//
// Tolerances are deliberate, and the two signals are not equal in strength:
//   • DOMAIN is near-definitive. Two records sharing a domain are the same organisation even when the
//     names differ wildly ("Burgess Institute … (formerly Spartan Innovations)"). Two records with
//     DIFFERENT domains are different organisations even when the names look similar.
//   • NAME alone is weak. Punctuation, legal suffixes, "formerly X" parentheticals and case all vary
//     without meaning anything, so a name difference on its own is not proof of a move.
// Hence: domains agree → same company (a rename). Domains differ → mismatch. No domain evidence →
// fall back to the name, fuzzily.

/** Bare registrable-ish host: scheme, credentials, `www.`, port, path and trailing dot removed. */
export function normalizeDomain(raw: unknown): string | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `http://${s}`;
  let host: string;
  try {
    host = new URL(withScheme).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  // A bare label with no dot ("undefined", "n/a") is not a domain.
  return host.includes('.') ? host : null;
}

const NOISE_WORDS = new Set([
  'inc', 'llc', 'llp', 'lp', 'ltd', 'co', 'corp', 'corporation', 'company', 'incorporated',
  'the', 'and', 'group', 'holdings', 'pllc', 'plc', 'pc',
]);

/**
 * Comparable form of a company name: parentheticals dropped (they carry "formerly …" noise),
 * punctuation flattened, legal suffixes and filler words removed.
 */
export function normalizeCompanyName(raw: unknown): string {
  const base = String(raw ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/&/g, ' and ')
    // Strip possessives BEFORE flattening punctuation. Otherwise "Wildana's" becomes the two tokens
    // {wildana, s}, and that stray single letter drags similarity down enough to fail an obvious
    // match — measured 2026-08-31: "Wildana's Touch And Taste" vs "Touch&Taste by Wildana" scored
    // 0.60 instead of 0.75 and was flagged as a different company.
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!base) return '';
  const words = base.split(' ').filter((w) => w && !NOISE_WORDS.has(w));
  return (words.length ? words : base.split(' ')).join(' ');
}

/** Share of tokens two normalized names have in common (Jaccard). */
export function tokenOverlap(a: string, b: string): number {
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

/**
 * Minimum token overlap to call two names the same business.
 *
 * 0.6 is chosen against real pairs, not by feel:
 *   • "Wildana's Touch And Taste" vs "Touch&Taste by Wildana" → 0.75, the SAME business reordered,
 *     which pure containment cannot see.
 *   • "Bailey" vs "Bailey & Friends" → 0.5, correctly NOT alike — one distinctive token in common is
 *     not evidence, and GHL holds both "Bailey & Co" and "Bailey & Friends".
 */
const MIN_TOKEN_OVERLAP = 0.6;

/**
 * True when two normalized names denote the same business: equal, one contained in the other on a
 * word boundary, or a high enough share of tokens in common to survive reordering.
 */
export function namesLookAlike(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // Containment only counts on a word boundary, so "acme" matches "acme labs" but not "acmedical".
  if (long === short || long.startsWith(`${short} `) || long.endsWith(` ${short}`) || long.includes(` ${short} `)) {
    return true;
  }
  // Reordering is not a difference: "Touch Taste by Wildana" is "Wildana's Touch And Taste".
  return tokenOverlap(a, b) >= MIN_TOKEN_OVERLAP;
}

export type IdentityVerdict = 'match' | 'renamed' | 'mismatch' | 'no-evidence';

export interface IdentityCheck {
  verdict: IdentityVerdict;
  /** True when the sync may proceed. */
  ok: boolean;
  reason: string;
  contactName?: string;
  companyName?: string;
  contactDomain?: string | null;
  companyDomain?: string | null;
}

export interface IdentityInputs {
  contactCompanyName?: unknown;
  contactWebsite?: unknown;
  companyName?: unknown;
  companyWebsite?: unknown;
}

/**
 * Does the contact's claimed employer match the company the association points at?
 *
 * `ok === false` means DO NOT WRITE — raise a review item instead. Everything else proceeds:
 * a rename is legitimate (same org, new name) and absent evidence cannot contradict the link.
 */
export function checkCompanyIdentity(input: IdentityInputs): IdentityCheck {
  const cDomain = normalizeDomain(input.contactWebsite);
  const bDomain = normalizeDomain(input.companyWebsite);
  const cName = normalizeCompanyName(input.contactCompanyName);
  const bName = normalizeCompanyName(input.companyName);

  const base = {
    contactName: String(input.contactCompanyName ?? '') || undefined,
    companyName: String(input.companyName ?? '') || undefined,
    contactDomain: cDomain,
    companyDomain: bDomain,
  };

  // Domain is the strong signal — decide on it whenever both sides have one.
  if (cDomain && bDomain) {
    if (cDomain === bDomain) {
      return namesLookAlike(cName, bName)
        ? { verdict: 'match', ok: true, reason: 'domain and name agree', ...base }
        : { verdict: 'renamed', ok: true, reason: `same domain (${cDomain}), different name — treated as a rename`, ...base };
    }
    return {
      verdict: 'mismatch', ok: false,
      reason: `different domains: contact ${cDomain} vs company ${bDomain}`,
      ...base,
    };
  }

  // No usable domain pair: fall back to the name, which can only be suggestive.
  if (cName && bName) {
    return namesLookAlike(cName, bName)
      ? { verdict: 'match', ok: true, reason: 'names agree', ...base }
      : {
          verdict: 'mismatch', ok: false,
          reason: `different company names and no shared domain: "${input.contactCompanyName}" vs "${input.companyName}"`,
          ...base,
        };
  }

  return { verdict: 'no-evidence', ok: true, reason: 'contact carries no company name or website to compare', ...base };
}
