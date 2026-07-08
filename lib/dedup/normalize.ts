// lib/dedup/normalize.ts — key normalization (pure).

const LEGAL_SUFFIXES = [
  'llc', 'l l c', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
  'ltd', 'limited', 'lp', 'llp', 'pllc', 'plc', 'pc',
];

/** Normalize a company name for weak duplicate grouping (never for auto-merge). */
export function normalizeName(name: string | null | undefined): string {
  if (!name) return '';
  let s = name.toLowerCase().trim();
  s = s.replace(/&/g, ' and ');
  s = s.replace(/[^a-z0-9\s]/g, ' ');        // drop punctuation
  s = s.replace(/\bdba\b.*$/, ' ');           // drop "dba ..." tails
  s = s.replace(/\s+/g, ' ').trim();
  // strip a trailing legal suffix (one pass)
  for (const suf of LEGAL_SUFFIXES) {
    if (s.endsWith(' ' + suf)) { s = s.slice(0, -(suf.length + 1)).trim(); break; }
  }
  return s.replace(/\s+/g, ' ').trim();
}

/** Normalize a LARA id to a comparable string. Numeric ids compared as integers
 *  (drops incidental leading zeros / decimals); non-numeric kept trimmed. */
export function normalizeLaraId(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === '' || s.toLowerCase() === 'n/a') return null;
  const digits = s.replace(/\D/g, '');
  if (digits && /^\d+$/.test(s.replace(/\s/g, ''))) return String(parseInt(digits, 10));
  return s.toLowerCase();
}
