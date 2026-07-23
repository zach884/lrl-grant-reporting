// lib/wix-sync/pipeline.ts — the full "contact changed → Team" reaction, in one place.
//
// One function both the unified webhook (/api/sync/up) and the standalone /api/wix-sync call, so
// a single GHL "Contact Changed" webhook can fan out to everything with no duplicated logic:
//   1. ENRICH — run the readiness-tagger when its CONFIG gate passes (default: contact.status=Approved
//      + website_team_tags ∈ {Team,EIR}). The gate is editable in /enrichment; a missing config row
//      falls back to that default. Runs first, so fresh service_areas + stops are on the GHL contact
//      BEFORE we push to Wix.
//   2. SYNC — run every enabled contact Wix mapping set; each set's contact.status gate decides
//      upsert / update / hide / skip and does the Published write-back. Equality-guarded (idempotent).

import { getContact } from '../ghl/contacts';
import { GhlClient, ghl } from '../ghl/client';
import { enrichContact, readContactField } from '../enrichment/contactEngine';
import { enrichRecord } from '../enrichment/recordEngine';
import { readinessTagger } from '../enrichment/enrichers/readinessTagger';
import { resourceTagger } from '../enrichment/enrichers/resourceTagger';
import { resolveEnricherConfig } from '../enrichment/configStore';
import { evaluateContactGate, evaluateGate } from '../enrichment/gate';
import { hasAnthropic } from '../ai/anthropic';
import { getWixStore } from '../mapping/wixStore';
import { getWixCollectionSchema } from '../wix/catalogCache';
import { readRecordFields } from '../ghl/records';
import { syncContactToWix, syncRecordToWix } from './sync';
import type { CustomFieldCatalog } from '../ghl/types';

/** contact.status value that (re-)triggers enrichment in the DEFAULT config (no row seeded). Kept
 *  exported for reference; the live gate is read from enricher_configs via resolveEnricherConfig. */
export const ENRICH_ON_STATUS = new Set(['Approved']);

export interface ContactTeamPipelineResult {
  status: string;
  enrich: { ran: boolean; applied?: string[]; note?: string };
  sets: Array<{
    set: string; collection: string; action: string;
    written: string[]; unchanged: number; skipped: unknown[];
    itemId?: string; note?: string; error?: string;
  }>;
}

/** Enrich (on Approved) then sync one contact to every enabled contact→Wix set. */
export async function runContactTeamPipeline(
  contactId: string,
  contactCatalog: CustomFieldCatalog,
  opts: { apply: boolean; ghlClient?: GhlClient },
): Promise<ContactTeamPipelineResult> {
  const gclient = opts.ghlClient ?? ghl();

  const contact = await getContact(contactId, gclient);
  const status = String(contact ? readContactField(contact, contactCatalog, 'contact.status') ?? '' : '');

  // 1) Enrich — gated by the enricher's CONFIG (status runOn + membership anyOf), read live from
  //    enricher_configs with a code-default fallback. Editing the gate in /enrichment changes this.
  const enrich: ContactTeamPipelineResult['enrich'] = { ran: false };
  if (!contact) {
    enrich.note = 'contact not found';
  } else if (!hasAnthropic) {
    enrich.note = 'ANTHROPIC_API_KEY not set';
  } else {
    const config = await resolveEnricherConfig('readiness-tagger', 'contact');
    const decision = evaluateContactGate((k) => readContactField(contact, contactCatalog, k), config);
    if (decision.run) {
      const er = await enrichContact(contactId, [readinessTagger], contactCatalog, { mode: 'overwrite' }, { apply: opts.apply, client: gclient });
      enrich.ran = true;
      enrich.applied = er.applied.map((a) => a.contactKey);
    } else {
      enrich.note = decision.reason;
    }
  }

  // 2) Sync every enabled contact set (the set gate decides the action per contact).
  const sets = await getWixStore().setsForSource('contact');
  const results: ContactTeamPipelineResult['sets'] = [];
  for (const set of sets) {
    try {
      const schema = await getWixCollectionSchema(set.wixCollectionId);
      const r = await syncContactToWix(contactId, set, contactCatalog, schema, { apply: opts.apply, ghlClient: gclient });
      results.push({
        set: set.name, collection: set.wixCollectionId, action: r.action,
        written: r.written.map((w) => w.targetColumn), unchanged: r.unchanged, skipped: r.skipped,
        itemId: r.itemId, note: r.note,
      });
    } catch (e: any) {
      results.push({ set: set.name, collection: set.wixCollectionId, action: 'error', written: [], unchanged: 0, skipped: [], error: e?.message ?? String(e) });
    }
  }

  return { status, enrich, sets: results };
}

// ── Resource (custom_objects.resources) pipeline — the Team pattern, one object over ─────────────

export interface ResourcePipelineResult {
  status: string;
  enrich: { ran: boolean; applied?: string[]; note?: string };
  sets: ContactTeamPipelineResult['sets'];
}

/** Enrich (resource-tagger, config-gated) then sync one resource record to every enabled
 *  custom_objects.resources → Wix set. Mirrors runContactTeamPipeline; uses the object-agnostic engine. */
export async function runResourcePipeline(
  recordId: string,
  resourceCatalog: CustomFieldCatalog,
  opts: { apply: boolean; ghlClient?: GhlClient },
): Promise<ResourcePipelineResult> {
  const OBJ = 'custom_objects.resources';
  const gclient = opts.ghlClient ?? ghl();

  let fields: Awaited<ReturnType<typeof readRecordFields>> | null = null;
  try { fields = await readRecordFields(OBJ, recordId, gclient); } catch { /* not found below */ }
  const status = String(fields?.get(`${OBJ}.resource_status`) ?? '');

  // 1) Enrich — gated by the resource-tagger's config (default resource_status ∈ {Approved}).
  const enrich: ResourcePipelineResult['enrich'] = { ran: false };
  if (!fields) {
    enrich.note = 'resource not found';
  } else if (!hasAnthropic) {
    enrich.note = 'ANTHROPIC_API_KEY not set';
  } else {
    const config = await resolveEnricherConfig('resource-tagger', OBJ);
    const decision = evaluateGate((k) => fields!.get(k), config);
    if (decision.run) {
      const er = await enrichRecord(OBJ, recordId, [resourceTagger], resourceCatalog, { mode: 'overwrite' }, { apply: opts.apply, client: gclient });
      enrich.ran = true;
      enrich.applied = er.applied.map((a) => a.fieldKey);
    } else {
      enrich.note = decision.reason;
    }
  }

  // 2) Sync every enabled resource set (each set's resource_status gate decides the action).
  const sets = await getWixStore().setsForSource(OBJ);
  const results: ResourcePipelineResult['sets'] = [];
  for (const set of sets) {
    try {
      const schema = await getWixCollectionSchema(set.wixCollectionId);
      const r = await syncRecordToWix(OBJ, recordId, set, resourceCatalog, schema, { apply: opts.apply, ghlClient: gclient });
      results.push({ set: set.name, collection: set.wixCollectionId, action: r.action, written: r.written.map((w) => w.targetColumn), unchanged: r.unchanged, skipped: r.skipped, itemId: r.itemId, note: r.note });
    } catch (e: any) {
      results.push({ set: set.name, collection: set.wixCollectionId, action: 'error', written: [], unchanged: 0, skipped: [], error: e?.message ?? String(e) });
    }
  }

  return { status, enrich, sets: results };
}
