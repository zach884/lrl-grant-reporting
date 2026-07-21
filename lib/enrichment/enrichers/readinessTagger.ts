// lib/enrichment/enrichers/readinessTagger.ts — classify a team member's profile into Brandon's
// 29-service taxonomy (Claude), then DERIVE their subway-map stops in code.
//
// Design (locked with Zach): the LLM assigns EXPERTISE (service tags) only; code derives the
// stop numbers from those tags via STOP_SERVICES. Benefits: a stop-definition change re-derives
// every contact's stops for free (no LLM calls — see rederiveProposals / the CLI --rederive), and
// the LLM never has to reason about the 4 readiness ladders — just "what is this person good at".
//
// Membership gate (REQUIRED): runs ONLY when contact.website_team_tags contains Team or EIR.
// Board-only contacts are skipped entirely (no tags/stops written). Mirrored in the embed query.
//
// Writes 7 GHL contact fields: service_areas (labels), mrl/trl/crl/investor_readiness_stops
// (number strings), readiness_confidence (High/Medium/Low), readiness_rationale (one line).

import type {
  ContactEnricher,
  ContactEnricherInput,
  ContactEnrichmentProposal,
  Provenance,
} from '../types';
import { hasAnthropic, classifyJson, CLASSIFIER_MODEL } from '../../ai/anthropic';
import {
  SERVICES,
  SERVICE_KEYS,
  LINE_KEYS,
  LINE_STOP_FIELD,
  deriveStops,
  normalizeTags,
  tagsToLabels,
  labelsToTags,
  type ServiceTag,
} from '../data/readiness';
import type { Contact, CustomFieldCatalog } from '../../ghl/types';
import { readContactField } from '../contactEngine';

/** Membership-gate values that mean "run the tagger". Board-only is excluded. */
const ALLOWED_MEMBERSHIP = new Set(['team', 'eir']);

/** Contact fields (in order) that describe who the person is / what they do. */
const PROFILE_KEYS: Array<[key: string, label: string]> = [
  ['contact.job_title', 'Job title'],
  ['contact.biowho_you_are', 'Bio'],
  ['contact.collectives', 'LRL collectives'],
  ['contact.linkedin', 'LinkedIn'],
  ['contact.your_website_andor_social_media_handle', 'Website/social'],
];

export interface ReadinessClassification {
  serviceTags: string[];
  confidence: 'High' | 'Medium' | 'Low';
  verify: boolean;
  rationale: string;
}

const CONFIDENCE_LEVELS = ['High', 'Medium', 'Low'] as const;

/** Structured-output schema for the classifier (tags only — code derives stops). */
const READINESS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    serviceTags: {
      type: 'array',
      items: { type: 'string', enum: Object.keys(SERVICES) },
      description: 'The 1–5 service-tag ids that best capture this person’s expertise.',
    },
    confidence: { type: 'string', enum: [...CONFIDENCE_LEVELS], description: 'Overall confidence in the tags.' },
    verify: { type: 'boolean', description: 'True when tags were inferred from thin/role-only data and a human should confirm.' },
    rationale: { type: 'string', description: 'One line: why these tags.' },
  },
  required: ['serviceTags', 'confidence', 'verify', 'rationale'],
};

/** The taxonomy menu, rendered for the system prompt. */
function taxonomyMenu(): string {
  return (Object.entries(SERVICES) as [ServiceTag, string][])
    .map(([id, label]) => `  ${id} = ${label}`)
    .join('\n');
}

export const READINESS_SYSTEM_PROMPT =
  `You classify a Lean Rocket Lab team member (a coach / entrepreneur-in-residence) into a fixed ` +
  `29-service expertise taxonomy. You assign ONLY expertise tags — you do NOT assign readiness ` +
  `stages or stop numbers (code derives those from your tags).\n\n` +
  `TAXONOMY (id = label). Choose tag IDS only from this list:\n${taxonomyMenu()}\n\n` +
  `CROSSWALK — map described specialties to tags consistently (same phrase → same tag):\n` +
  `  "design for manufacturing" / "DFM" → dfm; "lean / Six Sigma / continuous improvement" → lean;\n` +
  `  "go-to-market" / "GTM" → gtm; "patent attorney" → ip + legal; "fractional CFO" / "financial model" → finmodel;\n` +
  `  "customer discovery" / "I-Corps" → discovery; "supply chain" / "sourcing" → supply; "M&A" / "exit" → exit;\n` +
  `  "SBIR/STTR" / "federal grants" → grants; "contract manufacturing" → cm; "prototyping" / "rapid prototype" → proto;\n` +
  `  "ISO / AS9100 / quality system" → quality; "test & certification" → test; "systems engineering" → syseng;\n` +
  `  "tooling / automation" → tooling; "market research / TAM/SAM/SOM" → market; "pricing" → pricing;\n` +
  `  "sales / business development" → sales; "marketing / brand" → marketing; "fundraising / investor readiness" → fundraise;\n` +
  `  "business model" → bizmodel; "product management / product development" → product; "capital equipment / equipment financing" → capital;\n` +
  `  "regulatory / compliance" → regulatory; "R&D partnerships" → research; "ERP / MES / ops software" → erp;\n` +
  `  "workforce training" → workforce; "factory layout / industrial engineering" → facility.\n` +
  `  Domain crosswalks: "economic development" / "EDP director" → bizmodel + grants; "SBDC advisor/consultant"\n` +
  `  → bizmodel + finmodel + market; "leadership / management / executive coaching" → workforce; "CPA / accountant"\n` +
  `  → finmodel; "brand / creative / video / photography / storytelling" → marketing.\n\n` +
  `RULES:\n` +
  `  1. Explicit beats inferred — a stated specialty maps directly to its tag.\n` +
  `  2. Fewer, truer tags win. Return AT MOST 3 tags, and usually 1–2. A coach is later placed at every\n` +
  `     subway stop their tags touch, so an extra tag wrongly puts them on stops they can't actually help at.\n` +
  `  3. Every tag needs its OWN evidence in the profile. Do NOT add an adjacent/co-occurring service just\n` +
  `     because it often travels with another. In particular: do NOT add "product" to a marketing/creative\n` +
  `     person, and do NOT add "bizmodel", "lean", "discovery", or "sales" unless that specific service is\n` +
  `     clearly evidenced. A pure marketing/brand/video person is usually just ["marketing"] (+ "gtm" only\n` +
  `     if go-to-market/positioning is explicit).\n` +
  `  4. NO COACHABLE SPECIALTY → return an EMPTY serviceTags array — but use this NARROWLY. It applies only\n` +
  `     to clearly non-advisory roles: reception, scheduling, member services, facilities, office/operations\n` +
  `     admin, event coordination. For those, return [] with confidence "Low" and verify true.\n` +
  `     DO NOT empty-tag someone who advises founders. Directors (of entrepreneurship, operations, a program,\n` +
  `     an EDP), founders/CEOs, coaches, consultants, strategists, and domain experts ALWAYS have at least one\n` +
  `     real tag — infer their best 1–2 from their role/domain (with verify=true if the bio is thin) rather\n` +
  `     than returning empty. When unsure between "empty" and "one broad tag", pick the one broad tag.\n` +
  `  5. Set verify=true when inferring from thin data (a role title with little detail) rather than a stated specialty.\n` +
  `  6. confidence: High = specialties clearly stated; Medium = partly inferred; Low = mostly guessed / no clear specialty.\n` +
  `Return ONLY the structured object.`;

/** Assemble the labeled profile blob passed to the classifier. */
export function deriveProfileText(contact: Contact, catalog: CustomFieldCatalog): string {
  const parts: string[] = [];
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ');
  if (name) parts.push(`Name: ${name}`);
  const company = contact.companyName || readContactField(contact, catalog, 'website');
  if (company) parts.push(`Company: ${String(company)}`);
  for (const [key, label] of PROFILE_KEYS) {
    const v = readContactField(contact, catalog, key);
    const text = Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v);
    if (text.trim()) parts.push(`${label}: ${text.trim()}`);
  }
  return parts.join('\n');
}

/** True when the membership gate passes (website_team_tags contains Team or EIR). */
export function passesMembershipGate(membership: unknown): boolean {
  const values = Array.isArray(membership)
    ? membership
    : String(membership ?? '').split(/[,;]/);
  return values.some((v) => ALLOWED_MEMBERSHIP.has(String(v).trim().toLowerCase()));
}

/** Confidence label → provenance 0..1 (for dedupe/policy). */
const CONFIDENCE_SCORE: Record<string, number> = { High: 0.9, Medium: 0.6, Low: 0.3 };

/** Build the 7 field proposals from a set of service tags + confidence/verify/rationale. */
export function buildProposals(
  tags: ServiceTag[],
  confidence: ReadinessClassification['confidence'],
  verify: boolean,
  rationale: string,
  method: Provenance['method'],
): ContactEnrichmentProposal[] {
  if (tags.length === 0) return [];
  const stops = deriveStops(tags);
  const provenance: Provenance = {
    source: 'anthropic',
    method,
    confidence: CONFIDENCE_SCORE[confidence] ?? 0.3,
    timestamp: new Date().toISOString(),
    rationale: `${CLASSIFIER_MODEL}: ${rationale}`,
  };
  const rationaleText = (verify ? 'VERIFY — ' : '') + rationale;

  const proposals: ContactEnrichmentProposal[] = [
    { contactKey: 'contact.service_areas', value: tagsToLabels(tags), provenance },
  ];
  for (const line of LINE_KEYS) {
    proposals.push({
      contactKey: LINE_STOP_FIELD[line],
      value: stops[line].map(String),
      provenance,
    });
  }
  proposals.push({ contactKey: 'contact.readiness_confidence', value: confidence, provenance });
  proposals.push({ contactKey: 'contact.readiness_rationale', value: rationaleText, provenance });
  return proposals;
}

/**
 * Re-derive stops from the contact's EXISTING service_areas, with no LLM call. Used when
 * STOP_SERVICES changes: reads the already-classified tags off the contact and rewrites the 4
 * stop fields. Returns [] when the gate fails or no service_areas are set.
 */
export function rederiveProposals(input: ContactEnricherInput): ContactEnrichmentProposal[] {
  if (!passesMembershipGate(input.field('contact.website_team_tags'))) return [];
  const labels = input.field('contact.service_areas');
  const tags = labelsToTags(Array.isArray(labels) ? labels : []);
  if (tags.length === 0) return [];
  const stops = deriveStops(tags);
  const provenance: Provenance = {
    source: 'stop-derivation',
    method: 'computed',
    confidence: 1,
    timestamp: new Date().toISOString(),
    rationale: 'Re-derived stops from existing service_areas (STOP_SERVICES change)',
  };
  return LINE_KEYS.map((line) => ({
    contactKey: LINE_STOP_FIELD[line],
    value: stops[line].map(String),
    provenance,
  }));
}

export const readinessTagger: ContactEnricher = {
  name: 'readiness-tagger',
  description:
    'Classify a team member’s profile into the 29-service taxonomy (Claude) and derive subway-map ' +
    'stops. Runs only for Team/EIR contacts (membership gate).',
  produces: [
    'contact.service_areas',
    'contact.mrl_stops',
    'contact.trl_stops',
    'contact.crl_stops',
    'contact.investor_readiness_stops',
    'contact.readiness_confidence',
    'contact.readiness_rationale',
  ],

  async enrich(input: ContactEnricherInput): Promise<ContactEnrichmentProposal[]> {
    // Membership gate — Board-only contacts get nothing.
    if (!passesMembershipGate(input.field('contact.website_team_tags'))) return [];
    if (!hasAnthropic) return []; // no API key → skip cleanly

    const text = deriveProfileText(input.contact, input.contactCatalog);
    if (!text.trim()) return []; // nothing to classify from

    const result = await classifyJson<ReadinessClassification>({
      system: READINESS_SYSTEM_PROMPT,
      user: text,
      schema: READINESS_SCHEMA,
      maxTokens: 400,
    });
    if (!result) return [];

    // Keep only valid taxonomy ids (guards against any drift from the enum).
    const tags = normalizeTags(result.serviceTags).filter((t) => SERVICE_KEYS.has(t));
    const confidence = (CONFIDENCE_LEVELS as readonly string[]).includes(result.confidence)
      ? result.confidence
      : 'Low';
    const verify = Boolean(result.verify);
    const rationale = String(result.rationale ?? '');

    // No coachable specialty: record the assessment (confidence + rationale) so the contact is
    // marked "assessed, not placed" — but write no service_areas/stops, so they don't appear on
    // the map. Matches the prototype's untagged admin/support rows.
    if (tags.length === 0) {
      const provenance: Provenance = {
        source: 'anthropic',
        method: 'ai',
        confidence: CONFIDENCE_SCORE[confidence] ?? 0.3,
        timestamp: new Date().toISOString(),
        rationale: `${CLASSIFIER_MODEL}: ${rationale}`,
      };
      const rationaleText = (verify ? 'VERIFY — ' : '') + (rationale || 'No coachable specialty identified.');
      return [
        { contactKey: 'contact.readiness_confidence', value: confidence, provenance },
        { contactKey: 'contact.readiness_rationale', value: rationaleText, provenance },
      ];
    }

    return buildProposals(tags, confidence, verify, rationale, 'ai');
  },
};
