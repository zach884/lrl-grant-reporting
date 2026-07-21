// lib/enrichment/types.ts — pluggable enrichment interface.
//
// The differentiator: each Enricher takes a company and returns proposed field values
// WITH PROVENANCE (source + timestamp + confidence). The engine applies them under a
// policy (fill-empty vs overwrite, min-confidence) and records provenance for funder
// audit traceability. Adding a new enricher = implement this interface; no engine change.

import { BusinessRecord, Contact, CustomFieldCatalog } from '../ghl/types';

export interface Provenance {
  /** Where the value came from, e.g. 'census-geocoder', 'arcgis-hubzone-oz', 'lara-cofs'. */
  source: string;
  /** How it was derived. */
  method: 'api' | 'computed' | 'ai' | 'staff';
  /** 0..1 confidence. */
  confidence: number;
  /** ISO timestamp of when it was produced. */
  timestamp: string;
  /** Optional human-readable explanation (for audit). */
  rationale?: string;
}

export interface EnrichmentProposal {
  /** Company field to fill, e.g. 'business.county'. */
  businessKey: string;
  value: unknown;
  provenance: Provenance;
}

export interface DerivedAddress {
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
}

export interface GeocodeResult {
  county: string | null;
  /** In an SBA HUBZone (null if the layer query failed). */
  hubzone: boolean | null;
  /** In an Opportunity Zone (null if the layer query failed). */
  opportunityZone: boolean | null;
}

export interface EnricherInput {
  company: BusinessRecord;
  businessCatalog: CustomFieldCatalog;
  address: DerivedAddress;
  /** Memoized geocode for this company (shared across enrichers in one run). */
  geocode: () => Promise<GeocodeResult>;
}

export interface Enricher {
  name: string;
  description?: string;
  /** Company field keys this enricher can fill. */
  produces: string[];
  /** True if the enricher derives from the company address (county, geo-zone). The real-time
   *  hook only runs these when the company address actually changed; the nightly batch runs all. */
  addressDependent?: boolean;
  enrich(input: EnricherInput): Promise<EnrichmentProposal[]>;
}

export type ApplyMode = 'fill-empty' | 'overwrite';

export interface ApplyPolicy {
  mode: ApplyMode;
  /** Drop proposals below this confidence (0..1). Default 0. */
  minConfidence?: number;
}

export interface AppliedField {
  businessKey: string;
  value: unknown;
  provenance: Provenance;
}

export interface EnrichmentResult {
  companyId: string;
  /** Every proposal produced (deduped by field, highest confidence wins). */
  proposals: EnrichmentProposal[];
  /** Fields actually written (or that would be written in dry-run). */
  applied: AppliedField[];
  skipped: Array<{ businessKey: string; reason: string }>;
  didWrite: boolean;
}

// ── Contact-targeted enrichment ──────────────────────────────────────────────
// Mirrors the company enricher contract above (same Provenance + ApplyPolicy), but the target
// is a GHL CONTACT rather than a company. Added for the readiness-tagger, which classifies a
// person's profile. Adding a new contact enricher = implement ContactEnricher; no engine change.

export interface ContactEnricherInput {
  contact: Contact;
  contactCatalog: CustomFieldCatalog;
  /** Read any source field (standard scalar or custom field) off the contact by key. */
  field: (key: string) => unknown;
}

export interface ContactEnrichmentProposal {
  /** Contact field to fill, e.g. 'contact.service_areas'. */
  contactKey: string;
  value: unknown;
  provenance: Provenance;
}

export interface ContactEnricher {
  name: string;
  description?: string;
  /** Contact field keys this enricher can fill. */
  produces: string[];
  /** Return [] to skip cleanly (e.g. a membership gate fails, or no API key). */
  enrich(input: ContactEnricherInput): Promise<ContactEnrichmentProposal[]>;
}

export interface AppliedContactField {
  contactKey: string;
  value: unknown;
  provenance: Provenance;
}

export interface ContactEnrichmentResult {
  contactId: string;
  proposals: ContactEnrichmentProposal[];
  applied: AppliedContactField[];
  skipped: Array<{ contactKey: string; reason: string }>;
  didWrite: boolean;
}
