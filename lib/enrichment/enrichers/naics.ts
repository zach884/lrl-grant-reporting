// lib/enrichment/enrichers/naics.ts — classify a company's 6-digit NAICS code with Claude.
//
// LRL removes NAICS from the intake form and lets enrichment own it: clients don't know their
// code or submit the wrong number of digits. We classify from the company's descriptive text,
// validated against the official 2022 6-digit NAICS set, so only real codes are ever written.
//
// Proposes ONLY when the current value is missing or not a valid 6-digit code — an already-valid
// code is left alone (no needless AI calls or churn), which also makes the run idempotent.

import type { Enricher, EnricherInput, EnrichmentProposal } from '../types';
import { hasAnthropic, classifyJson } from '../../ai/anthropic';
import naicsData from '../data/naics-2022.json';

const NAICS: Record<string, string> = naicsData as Record<string, string>;

/** Company descriptive fields (bare keys) that describe what the business does. */
const TEXT_KEYS: Array<[key: string, label: string]> = [
  ['description', 'Description'],
  ['problem_you_solve', 'Problem solved'],
  ['target_customer', 'Target customer'],
  ['business_model', 'Business model'],
  ['tech_product_state', 'Product/tech'],
  ['mfg_method', 'How it is made'],
  ['biggest_challenge', 'Biggest challenge'],
  ['success_next_12mo', 'Goals'],
];

const NAICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    naics_code: { type: 'string', description: 'The single best 6-digit 2022 NAICS code' },
    confidence: { type: 'number', description: '0..1 confidence the code is correct' },
    rationale: { type: 'string', description: 'One sentence: why this code fits' },
  },
  required: ['naics_code', 'confidence', 'rationale'],
};

const digitsOnly = (v: unknown) => String(v ?? '').replace(/\D/g, '');

/** Assemble a labeled description blob from the company's properties. */
export function deriveNaicsText(properties: Record<string, unknown>): string {
  const parts: string[] = [];
  const name = properties['name'];
  if (name) parts.push(`Company: ${String(name)}`);
  for (const [key, label] of TEXT_KEYS) {
    const v = properties[key];
    if (v != null && String(v).trim()) parts.push(`${label}: ${String(v).trim()}`);
  }
  return parts.join('\n');
}

export const naicsEnricher: Enricher = {
  name: 'naics',
  description: 'Classify the 6-digit NAICS code from the company description (Claude), validated against the official 2022 NAICS set.',
  produces: ['business.naics_code'],

  async enrich(input: EnricherInput): Promise<EnrichmentProposal[]> {
    if (!hasAnthropic) return []; // no API key → skip cleanly

    // Skip if the company already has a valid 6-digit NAICS code.
    const current = digitsOnly(input.company.properties['naics_code']);
    if (current.length === 6 && NAICS[current]) return [];

    const text = deriveNaicsText(input.company.properties);
    if (!text) return []; // nothing to classify from

    const result = await classifyJson<{ naics_code: string; confidence: number; rationale: string }>({
      system:
        'You are a NAICS classification expert. Given a company description, return the single best ' +
        'US 2022 6-digit NAICS code. Return only a real 6-digit code. If unsure, give your best guess ' +
        'with a lower confidence.',
      user: text,
      schema: NAICS_SCHEMA,
    });
    if (!result) return [];

    const code = digitsOnly(result.naics_code);
    if (code.length !== 6 || !NAICS[code]) return []; // hallucinated / not a real code

    const confidence = Math.max(0, Math.min(1, Number(result.confidence) || 0));
    return [
      {
        businessKey: 'business.naics_code',
        value: Number(code),
        provenance: {
          source: 'naics-ai-classifier',
          method: 'ai',
          confidence,
          timestamp: new Date().toISOString(),
          rationale: `${code} ${NAICS[code]} — ${result.rationale}`,
        },
      },
    ];
  },
};
