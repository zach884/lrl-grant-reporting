// lib/enrichment/data/readiness.ts — the readiness-map taxonomy, lifted verbatim from
// Brandon's providers-db.js (Google Drive › Shared drives › Claude › LRL Readiness Map,
// updated 2026-07-17). SINGLE SOURCE OF TRUTH for both the LLM prompt (the tag menu the
// classifier may choose from) AND the deterministic stop derivation (tags → stop numbers).
//
// Design principle (locked with Zach): the LLM assigns expertise (service tags); CODE derives
// stop numbers from the tags via STOP_SERVICES. So when a stop's definition changes, we re-derive
// every contact's stop fields instantly (no LLM calls) — see `deriveStops` and the CLI --rederive.
//
// To change the taxonomy: edit SERVICES / STOP_SERVICES here to match providers-db.js, and the
// embed's inline copy in wix-embed/readiness-subway-map.html. (The GHL `service_areas` option
// labels must equal the SERVICES *values*; the stop fields accept the number strings.)

/** The 29-service master taxonomy: tag id → display label. */
export const SERVICES = {
  ip: 'IP & Patents',
  legal: 'Legal & Contracts',
  grants: 'Non-dilutive Funding',
  research: 'R&D Partnerships',
  proto: 'Prototyping',
  dfm: 'Design for Manufacturing',
  cm: 'Contract Manufacturing',
  supply: 'Supply Chain',
  quality: 'Quality Systems (ISO/AS)',
  lean: 'Lean & Continuous Improvement',
  test: 'Test & Certification',
  syseng: 'Systems Engineering',
  tooling: 'Tooling & Automation',
  facility: 'Factory Layout & Industrial Eng.',
  workforce: 'Workforce Training',
  erp: 'ERP / MES & Ops Software',
  regulatory: 'Regulatory & Compliance',
  market: 'Market Research',
  discovery: 'Customer Discovery',
  gtm: 'Go-to-Market Strategy',
  pricing: 'Pricing Strategy',
  sales: 'Sales & Business Development',
  marketing: 'Marketing & Brand',
  finmodel: 'Financial Modeling',
  fundraise: 'Fundraising & Investor Readiness',
  bizmodel: 'Business Model Design',
  product: 'Product Management',
  capital: 'Capital Equipment & Financing',
  exit: 'M&A / Exit Planning',
} as const;

/** A valid service-tag id. */
export type ServiceTag = keyof typeof SERVICES;

/** The four readiness lines. */
export type LineKey = 'MRL' | 'TRL' | 'CRL' | 'IRL';
export const LINE_KEYS: LineKey[] = ['MRL', 'TRL', 'CRL', 'IRL'];

/** Set of valid tag ids (for validating LLM output). */
export const SERVICE_KEYS: ReadonlySet<string> = new Set(Object.keys(SERVICES));

/** The GHL contact field key for each line's stop field. */
export const LINE_STOP_FIELD: Record<LineKey, string> = {
  MRL: 'contact.mrl_stops',
  TRL: 'contact.trl_stops',
  CRL: 'contact.crl_stops',
  IRL: 'contact.investor_readiness_stops',
};

/**
 * STOP_SERVICES — the services typically needed to *exit* each stop on each line.
 * line code → stop number → array of service ids. A contact is placed at a stop when their
 * service tags intersect that stop's needs. (MRL 1–10, TRL/CRL/IRL 1–9.)
 */
export const STOP_SERVICES: Record<LineKey, Record<number, ServiceTag[]>> = {
  MRL: {
    1: ['research', 'grants', 'ip'],
    2: ['dfm', 'proto', 'grants'],
    3: ['proto', 'ip', 'dfm'],
    4: ['dfm', 'quality', 'supply'],
    5: ['cm', 'supply', 'tooling'],
    6: ['cm', 'lean', 'tooling', 'workforce'],
    7: ['facility', 'quality', 'workforce'],
    8: ['capital', 'erp', 'regulatory', 'quality'],
    9: ['lean', 'supply', 'capital'],
    10: ['lean', 'tooling', 'workforce'],
  },
  TRL: {
    1: ['research', 'grants'],
    2: ['ip', 'grants', 'research'],
    3: ['proto', 'test', 'research'],
    4: ['proto', 'test', 'syseng'],
    5: ['syseng', 'test', 'supply'],
    6: ['test', 'regulatory', 'syseng'],
    7: ['regulatory', 'quality', 'test'],
    8: ['quality', 'regulatory', 'product'],
    9: ['product', 'syseng', 'market'],
  },
  CRL: {
    1: ['market', 'discovery'],
    2: ['market', 'discovery', 'gtm'],
    3: ['discovery', 'gtm', 'marketing'],
    4: ['pricing', 'sales', 'legal'],
    5: ['pricing', 'sales', 'finmodel', 'grants'],
    6: ['sales', 'marketing', 'product'],
    7: ['marketing', 'sales', 'gtm'],
    8: ['sales', 'marketing', 'finmodel', 'workforce'],
    9: ['exit', 'gtm', 'finmodel'],
  },
  IRL: {
    1: ['bizmodel', 'discovery'],
    2: ['market', 'bizmodel'],
    3: ['discovery', 'product', 'fundraise'],
    4: ['proto', 'product', 'discovery'],
    5: ['gtm', 'pricing', 'fundraise'],
    6: ['sales', 'pricing', 'finmodel'],
    7: ['product', 'finmodel', 'fundraise'],
    8: ['supply', 'finmodel', 'legal'],
    9: ['fundraise', 'exit', 'finmodel'],
  },
};

/** Keep only valid, de-duplicated tag ids (in taxonomy order). */
export function normalizeTags(tags: unknown): ServiceTag[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const out: ServiceTag[] = [];
  for (const t of tags) {
    const id = String(t).trim().toLowerCase();
    if (SERVICE_KEYS.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id as ServiceTag);
    }
  }
  return out;
}

/** Map service-tag ids to their display labels (skips unknown ids). */
export function tagsToLabels(tags: readonly string[]): string[] {
  return tags
    .map((t) => SERVICES[t as ServiceTag] as string | undefined)
    .filter((l): l is string => Boolean(l));
}

/** Reverse of tagsToLabels: display labels → tag ids (skips unknown labels). */
const LABEL_TO_TAG: Record<string, ServiceTag> = Object.fromEntries(
  (Object.entries(SERVICES) as [ServiceTag, string][]).map(([id, label]) => [label, id]),
) as Record<string, ServiceTag>;

export function labelsToTags(labels: readonly string[]): ServiceTag[] {
  const out: ServiceTag[] = [];
  const seen = new Set<string>();
  for (const l of labels) {
    const id = LABEL_TO_TAG[String(l).trim()];
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

/** Stop numbers on one line whose needs intersect the given tags (ascending). */
export function stopsForLine(line: LineKey, tags: readonly string[]): number[] {
  const tagSet = new Set(tags);
  const stops: number[] = [];
  for (const [nStr, needs] of Object.entries(STOP_SERVICES[line])) {
    if (needs.some((s) => tagSet.has(s))) stops.push(Number(nStr));
  }
  return stops.sort((a, b) => a - b);
}

export interface DerivedStops {
  MRL: number[];
  TRL: number[];
  CRL: number[];
  IRL: number[];
}

/**
 * Deterministically derive every line's stop numbers from a person's service tags.
 * This is the CODE half of the design: no LLM involved, so it can be re-run for free whenever
 * STOP_SERVICES changes (see the CLI --rederive path).
 */
export function deriveStops(tags: readonly string[]): DerivedStops {
  const clean = normalizeTags(tags);
  return {
    MRL: stopsForLine('MRL', clean),
    TRL: stopsForLine('TRL', clean),
    CRL: stopsForLine('CRL', clean),
    IRL: stopsForLine('IRL', clean),
  };
}
