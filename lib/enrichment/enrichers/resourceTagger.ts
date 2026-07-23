// lib/enrichment/enrichers/resourceTagger.ts — classify a Resource (a technical-assistance provider
// ORGANIZATION) into Brandon's 29-service taxonomy (Claude), then DERIVE its subway-map stops in code.
//
// The record-targeted twin of the readiness tagger. Same design (LLM assigns service tags; code
// derives stops via STOP_SERVICES) and the same taxonomy + deriveStops — only the classifier prompt
// differs (it reasons about what services an ORG provides, not a person's expertise) and it writes to
// custom_objects.resources fields instead of contact fields. Gating (resource_status) is config, not
// code — enforced by the caller via lib/enrichment/gate.ts, editable in /enrichment.

import type { Provenance, RecordEnricher, RecordEnricherInput, RecordEnrichmentProposal } from '../types';
import { hasAnthropic, classifyJson, CLASSIFIER_MODEL } from '../../ai/anthropic';
import { SERVICES, SERVICE_KEYS, LINE_KEYS, deriveStops, normalizeTags, tagsToLabels, type ServiceTag, type LineKey } from '../data/readiness';

/** Bare stop-field names on the resources object (contact uses the same, prefixed differently). */
const STOP_BARE: Record<LineKey, string> = { MRL: 'mrl_stops', TRL: 'trl_stops', CRL: 'crl_stops', IRL: 'investor_readiness_stops' };

/** Resource fields (bare) that describe what the organization does. */
const PROFILE_FIELDS: Array<[key: string, label: string]> = [
  ['resources', 'Name'],
  ['category', 'Category'],
  ['sub_category', 'Sub-category'],
  ['short_description', 'Short description'],
  ['full_description', 'Description'],
  ['website', 'Website'],
];

const CONFIDENCE_LEVELS = ['High', 'Medium', 'Low'] as const;
interface ResourceClassification { serviceTags: string[]; confidence: 'High' | 'Medium' | 'Low'; verify: boolean; rationale: string }
const CONFIDENCE_SCORE: Record<string, number> = { High: 0.9, Medium: 0.6, Low: 0.3 };

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    serviceTags: { type: 'array', items: { type: 'string', enum: Object.keys(SERVICES) }, description: 'The 1–3 service-tag ids this organization PROVIDES.' },
    confidence: { type: 'string', enum: [...CONFIDENCE_LEVELS] },
    verify: { type: 'boolean', description: 'True when inferred from thin data (a category with little detail).' },
    rationale: { type: 'string', description: 'One line: why these tags.' },
  },
  required: ['serviceTags', 'confidence', 'verify', 'rationale'],
};

function taxonomyMenu(): string {
  return (Object.entries(SERVICES) as [ServiceTag, string][]).map(([id, label]) => `  ${id} = ${label}`).join('\n');
}

export const RESOURCE_SYSTEM_PROMPT =
  `You classify a Lean Rocket Lab RESOURCE — a technical-assistance provider (an organization, fund, ` +
  `firm, accelerator, or program) — into a fixed 29-service taxonomy, based on the services the ` +
  `organization PROVIDES to startups. You assign ONLY service tags — you do NOT assign readiness ` +
  `stages or stop numbers (code derives those from your tags).\n\n` +
  `TAXONOMY (id = label). Choose tag IDS only from this list:\n${taxonomyMenu()}\n\n` +
  `CROSSWALK — map an org's offering to tags consistently:\n` +
  `  law firm / IP or patent attorney → ip + legal; "SBIR/STTR support" / grant writing / proposal help → grants;\n` +
  `  accelerator / incubator → bizmodel + fundraise (add gtm/market only if explicit); CDFI / fund / venture / angel\n` +
  `  / "capital" → fundraise; SBIR/STTR match or grant fund → grants; SBDC / MEDC / EDC / economic development →\n` +
  `  bizmodel + grants + market; accounting / CPA / fractional CFO / bookkeeping → finmodel; marketing / brand /\n` +
  `  creative / video / storytelling / PR → marketing; contract manufacturer / machine shop → cm; prototyping /\n` +
  `  rapid prototype shop → proto; testing / certification / quality lab → test + quality; design-for-manufacturing\n` +
  `  → dfm; supply chain / sourcing → supply; workforce / training → workforce; regulatory / compliance → regulatory.\n\n` +
  `RULES:\n` +
  `  1. Explicit beats inferred — a stated service maps directly to its tag.\n` +
  `  2. Fewer, truer tags win. Return AT MOST 3, usually 1–2. An org is placed at every subway stop its tags touch,\n` +
  `     so an extra tag wrongly puts it on stops it can't actually help at.\n` +
  `  3. Every tag needs its OWN evidence in the name/category/description. A pure funder is just ["fundraise"]\n` +
  `     (or ["grants"] for an SBIR/grant fund). A pure law firm is ["ip","legal"] (or just ["legal"]).\n` +
  `  4. NO CLEAR SERVICE (a bare directory listing, a generic association with no described offering) → return an\n` +
  `     EMPTY serviceTags array with confidence "Low" and verify true.\n` +
  `  5. Set verify=true when inferring from a category alone (little description).\n` +
  `  6. confidence: High = services clearly described; Medium = partly inferred; Low = mostly guessed.\n` +
  `Return ONLY the structured object.`;

/** Assemble the labeled profile blob passed to the classifier. */
export function deriveResourceText(field: (key: string) => unknown): string {
  const parts: string[] = [];
  for (const [key, label] of PROFILE_FIELDS) {
    const v = field(key);
    const text = Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v);
    if (text.trim()) parts.push(`${label}: ${text.trim()}`);
  }
  return parts.join('\n');
}

/** Build the field proposals from service tags + confidence/verify/rationale (keyed to the object). */
export function buildResourceProposals(
  objectKey: string,
  tags: ServiceTag[],
  confidence: ResourceClassification['confidence'],
  verify: boolean,
  rationale: string,
  method: Provenance['method'],
): RecordEnrichmentProposal[] {
  const provenance: Provenance = {
    source: 'anthropic',
    method,
    confidence: CONFIDENCE_SCORE[confidence] ?? 0.3,
    timestamp: new Date().toISOString(),
    rationale: `${CLASSIFIER_MODEL}: ${rationale}`,
  };
  const rationaleText = (verify ? 'VERIFY — ' : '') + rationale;
  // Non-placement assessment (no coachable service): record confidence + rationale only.
  if (tags.length === 0) {
    return [
      { fieldKey: `${objectKey}.readiness_confidence`, value: confidence, provenance },
      { fieldKey: `${objectKey}.readiness_rationale`, value: rationaleText || 'No clear service identified.', provenance },
    ];
  }
  const stops = deriveStops(tags);
  const out: RecordEnrichmentProposal[] = [
    { fieldKey: `${objectKey}.service_areas`, value: tagsToLabels(tags), provenance },
  ];
  for (const line of LINE_KEYS) out.push({ fieldKey: `${objectKey}.${STOP_BARE[line]}`, value: stops[line].map(String), provenance });
  out.push({ fieldKey: `${objectKey}.readiness_confidence`, value: confidence, provenance });
  out.push({ fieldKey: `${objectKey}.readiness_rationale`, value: rationaleText, provenance });
  return out;
}

export const resourceTagger: RecordEnricher = {
  name: 'resource-tagger',
  description:
    'Classify a Resource (technical-assistance provider) into the 29-service taxonomy (Claude) and ' +
    'derive subway-map stops. Status gate is configurable (default: resource_status = Approved).',
  produces: [
    'custom_objects.resources.service_areas',
    'custom_objects.resources.mrl_stops',
    'custom_objects.resources.trl_stops',
    'custom_objects.resources.crl_stops',
    'custom_objects.resources.investor_readiness_stops',
    'custom_objects.resources.readiness_confidence',
    'custom_objects.resources.readiness_rationale',
  ],

  async enrich(input: RecordEnricherInput): Promise<RecordEnrichmentProposal[]> {
    if (!hasAnthropic) return [];
    const text = deriveResourceText(input.field);
    if (!text.trim()) return [];

    const result = await classifyJson<ResourceClassification>({ system: RESOURCE_SYSTEM_PROMPT, user: text, schema: SCHEMA, maxTokens: 400 });
    if (!result) return [];

    const tags = normalizeTags(result.serviceTags).filter((t) => SERVICE_KEYS.has(t));
    const confidence = (CONFIDENCE_LEVELS as readonly string[]).includes(result.confidence) ? result.confidence : 'Low';
    return buildResourceProposals(input.objectKey, tags, confidence, Boolean(result.verify), String(result.rationale ?? ''), 'ai');
  },
};
