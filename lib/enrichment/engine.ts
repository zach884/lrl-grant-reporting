// lib/enrichment/engine.ts — run enrichers over a company and apply proposals.

import { GhlClient, ghl } from '../ghl/client';
import { BusinessRecord, CustomFieldCatalog } from '../ghl/types';
import { isUnwritable, isCreateOnly, resolveOptionKey } from '../ghl/coerce';
import type { CustomFieldDef } from '../ghl/types';
import { getBusinessRecord, setBusinessFields } from '../ghl/businesses';
import { enrichAddress } from '../enrich';
import {
  Enricher,
  EnricherInput,
  EnrichmentProposal,
  EnrichmentResult,
  ApplyPolicy,
  AppliedField,
  DerivedAddress,
  GeocodeResult,
} from './types';
import { resolveEnricherConfig } from './configStore';
import { evaluateGate } from './gate';
import { logEnrichment } from '../audit/log';

const bare = (k: string) => k.replace(/^business\./, '');

/** True if the proposed value already matches the company's current value (so no write is
 *  needed). Option fields compare by resolved key (label↔key); others compare case-insensitively. */
function alreadyEqual(def: CustomFieldDef, current: unknown, proposed: unknown): boolean {
  if (def.dataType === 'SINGLE_OPTIONS' || def.dataType === 'RADIO') {
    return resolveOptionKey(current, def.options) === resolveOptionKey(proposed, def.options);
  }
  return String(current ?? '').trim().toLowerCase() === String(proposed ?? '').trim().toLowerCase();
}

/** Pull address inputs from a company record's properties (several key spellings). */
export function deriveAddress(company: BusinessRecord): DerivedAddress {
  const p = company.properties;
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = p[k];
      if (v != null && v !== '') return String(v);
    }
    return undefined;
  };
  return {
    address1: pick('address', 'address1', 'street_address'),
    city: pick('city'),
    state: pick('state'),
    postalCode: pick('postalcode', 'postal_code', 'postalCode', 'zip'),
  };
}

/** Dedupe proposals by field, keeping the highest-confidence one. */
function dedupe(proposals: EnrichmentProposal[]): EnrichmentProposal[] {
  const best = new Map<string, EnrichmentProposal>();
  for (const p of proposals) {
    const cur = best.get(p.businessKey);
    if (!cur || p.provenance.confidence > cur.provenance.confidence) best.set(p.businessKey, p);
  }
  return Array.from(best.values());
}

/** Run enrichers, returning deduped proposals (no writes). */
export async function runEnrichers(
  company: BusinessRecord,
  businessCatalog: CustomFieldCatalog,
  enrichers: Enricher[],
): Promise<EnrichmentProposal[]> {
  const address = deriveAddress(company);
  let geocodeCache: GeocodeResult | undefined;
  const geocode = async (): Promise<GeocodeResult> => {
    if (geocodeCache) return geocodeCache;
    const r = await enrichAddress(
      address.address1 ?? '', address.city ?? '', address.state ?? '', address.postalCode ?? '',
    );
    geocodeCache = { county: r.county, hubzone: r.hubzone ?? null, opportunityZone: r.opportunityZone ?? null };
    return geocodeCache;
  };
  const input: EnricherInput = { company, businessCatalog, address, geocode };

  // Read a company field for the gate (custom field in properties, else a top-level scalar).
  const readField = (key: string): unknown => {
    const k = bare(key);
    const p = company.properties?.[k];
    return p != null && p !== '' ? p : (company as unknown as Record<string, unknown>)[k];
  };

  const all: EnrichmentProposal[] = [];
  for (const e of enrichers) {
    // Config gate (default = no gate => always runs, so unconfigured behavior is unchanged).
    // resolveEnricherConfig never throws (falls back to the code default), so this is fail-open.
    const config = await resolveEnricherConfig(e.name, 'business');
    if (!evaluateGate(readField, config).run) continue;
    try {
      all.push(...(await e.enrich(input)));
    } catch {
      /* one enricher failing must not abort the rest */
    }
  }
  return dedupe(all);
}

/** Decide which proposals to write under the policy, then write them. */
export async function applyProposals(
  companyId: string,
  company: BusinessRecord,
  proposals: EnrichmentProposal[],
  businessCatalog: CustomFieldCatalog,
  policy: ApplyPolicy,
  opts: { apply: boolean; client?: GhlClient } = { apply: false },
): Promise<EnrichmentResult> {
  const minConf = policy.minConfidence ?? 0;
  const applied: AppliedField[] = [];
  const skipped: EnrichmentResult['skipped'] = [];
  const values: Record<string, unknown> = {};

  for (const p of proposals) {
    if (p.provenance.confidence < minConf) {
      skipped.push({ businessKey: p.businessKey, reason: `below min confidence (${p.provenance.confidence})` });
      continue;
    }
    const def = businessCatalog.byKey[p.businessKey] ?? businessCatalog.byKey[`business.${bare(p.businessKey)}`];
    if (!def) { skipped.push({ businessKey: p.businessKey, reason: 'field not in company catalog' }); continue; }
    if (isUnwritable(def.dataType)) { skipped.push({ businessKey: p.businessKey, reason: `unwritable type ${def.dataType}` }); continue; }
    if (isCreateOnly(def.dataType)) { skipped.push({ businessKey: p.businessKey, reason: `create-only type ${def.dataType} (cannot enrich via update)` }); continue; }

    const current = company.properties[bare(p.businessKey)];
    const hasValue = current != null && current !== '' && !(Array.isArray(current) && current.length === 0);
    if (policy.mode === 'fill-empty' && hasValue) {
      skipped.push({ businessKey: p.businessKey, reason: 'already set (fill-empty)' });
      continue;
    }
    // Idempotency guard (applies in overwrite mode too): don't rewrite an unchanged value.
    if (hasValue && alreadyEqual(def, current, p.value)) {
      skipped.push({ businessKey: p.businessKey, reason: 'already up to date' });
      continue;
    }
    values[bare(p.businessKey)] = p.value;
    applied.push({ businessKey: p.businessKey, value: p.value, provenance: p.provenance });
  }

  let didWrite = false;
  if (opts.apply && Object.keys(values).length > 0) {
    const client = opts.client ?? ghl();
    await setBusinessFields(companyId, values, businessCatalog.byKey, client);
    didWrite = true;
  }

  return { companyId, proposals, applied, skipped, didWrite };
}

/** End-to-end: read company, run enrichers, apply under policy. */
export async function enrichCompany(
  companyId: string,
  enrichers: Enricher[],
  businessCatalog: CustomFieldCatalog,
  policy: ApplyPolicy,
  opts: { apply: boolean; client?: GhlClient } = { apply: false },
): Promise<EnrichmentResult> {
  const client = opts.client ?? ghl();
  const company = await getBusinessRecord(companyId, client);
  if (!company) throw new Error(`Company ${companyId} not found`);
  const proposals = await runEnrichers(company, businessCatalog, enrichers);
  const result = await applyProposals(companyId, company, proposals, businessCatalog, policy, opts);
  if (opts.apply && result.applied.length) {
    await logEnrichment({
      objectType: 'business', recordId: companyId, recordLabel: String(company.properties?.name ?? ''),
      actorName: 'company-enrichers', applyMode: opts.apply,
      applied: result.applied.map((a) => ({ key: a.businessKey, value: a.value, provenance: a.provenance })),
    });
  }
  return result;
}
