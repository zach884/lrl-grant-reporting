// lib/enrichment/recordEngine.ts — run record-targeted enrichers over ANY GHL object record.
//
// The object-agnostic twin of contactEngine: reads a record's fields (lib/ghl/records), runs
// RecordEnrichers → dedupes proposals → applies under a policy (fill-empty vs overwrite, min-
// confidence) with an idempotency guard, writing via the object-agnostic writeRecordFields. Built
// for the resource tagger (custom_objects.resources), but works for business / any custom object.

import { GhlClient, ghl } from '../ghl/client';
import { readRecordFields } from '../ghl/records';
import { writeRecordFields } from '../ghl/writeRecord';
import type { CustomFieldCatalog } from '../ghl/types';
import {
  ApplyPolicy,
  AppliedRecordField,
  RecordEnricher,
  RecordEnricherInput,
  RecordEnrichmentProposal,
  RecordEnrichmentResult,
} from './types';

/** Normalize a value for equality comparison (arrays order-insensitive, strings case-insensitive). */
function normForCompare(v: unknown): unknown {
  if (Array.isArray(v)) return [...v].map((x) => String(x).trim().toLowerCase()).sort();
  if (v == null) return '';
  return String(v).trim().toLowerCase();
}
function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normForCompare(a)) === JSON.stringify(normForCompare(b));
}
const isEmpty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

/** Dedupe proposals by target field, keeping the highest-confidence one. */
function dedupe(proposals: RecordEnrichmentProposal[]): RecordEnrichmentProposal[] {
  const best = new Map<string, RecordEnrichmentProposal>();
  for (const p of proposals) {
    const cur = best.get(p.fieldKey);
    if (!cur || p.provenance.confidence > cur.provenance.confidence) best.set(p.fieldKey, p);
  }
  return Array.from(best.values());
}

/** Run record enrichers, returning deduped proposals (no writes). One failing enricher is skipped. */
export async function runRecordEnrichers(
  input: RecordEnricherInput,
  enrichers: RecordEnricher[],
): Promise<RecordEnrichmentProposal[]> {
  const all: RecordEnrichmentProposal[] = [];
  for (const e of enrichers) {
    try {
      all.push(...(await e.enrich(input)));
    } catch {
      /* one enricher failing must not abort the rest */
    }
  }
  return dedupe(all);
}

/** Decide which proposals to write under the policy, then write them. */
export async function applyRecordProposals(
  objectKey: string,
  recordId: string,
  proposals: RecordEnrichmentProposal[],
  catalog: CustomFieldCatalog,
  field: (key: string) => unknown,
  policy: ApplyPolicy,
  opts: { apply: boolean; client?: GhlClient } = { apply: false },
): Promise<RecordEnrichmentResult> {
  const minConf = policy.minConfidence ?? 0;
  const applied: AppliedRecordField[] = [];
  const skipped: RecordEnrichmentResult['skipped'] = [];
  const changes: Record<string, unknown> = {};

  for (const p of proposals) {
    if (p.provenance.confidence < minConf) {
      skipped.push({ fieldKey: p.fieldKey, reason: `below min confidence (${p.provenance.confidence})` });
      continue;
    }
    const def = catalog.byKey[p.fieldKey] ?? catalog.byKey[`${objectKey}.${p.fieldKey}`];
    if (!def) {
      skipped.push({ fieldKey: p.fieldKey, reason: 'field not in object catalog' });
      continue;
    }
    const current = field(p.fieldKey);
    if (policy.mode === 'fill-empty' && !isEmpty(current)) {
      skipped.push({ fieldKey: p.fieldKey, reason: 'already set (fill-empty)' });
      continue;
    }
    if (!isEmpty(current) && valuesEqual(current, p.value)) {
      skipped.push({ fieldKey: p.fieldKey, reason: 'already up to date' });
      continue;
    }
    if (isEmpty(p.value)) {
      skipped.push({ fieldKey: p.fieldKey, reason: 'proposed value empty' });
      continue;
    }
    changes[p.fieldKey] = p.value;
    applied.push({ fieldKey: p.fieldKey, value: p.value, provenance: p.provenance });
  }

  let didWrite = false;
  if (opts.apply && Object.keys(changes).length > 0) {
    const client = opts.client ?? ghl();
    await writeRecordFields(objectKey, recordId, changes, catalog, client);
    didWrite = true;
  }

  return { objectKey, recordId, proposals, applied, skipped, didWrite };
}

/** End-to-end: read the record, run enrichers, apply under policy. */
export async function enrichRecord(
  objectKey: string,
  recordId: string,
  enrichers: RecordEnricher[],
  catalog: CustomFieldCatalog,
  policy: ApplyPolicy,
  opts: { apply: boolean; client?: GhlClient } = { apply: false },
): Promise<RecordEnrichmentResult> {
  const client = opts.client ?? ghl();
  const fields = await readRecordFields(objectKey, recordId, client);
  const input: RecordEnricherInput = { objectKey, recordId, catalog, field: (k) => fields.get(k) };
  const proposals = await runRecordEnrichers(input, enrichers);
  return applyRecordProposals(objectKey, recordId, proposals, catalog, input.field, policy, opts);
}
