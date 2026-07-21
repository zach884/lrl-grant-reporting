// lib/wix-sync/pipeline.ts — the full "contact changed → Team" reaction, in one place.
//
// One function both the unified webhook (/api/sync/up) and the standalone /api/wix-sync call, so
// a single GHL "Contact Changed" webhook can fan out to everything with no duplicated logic:
//   1. ENRICH — run the readiness-tagger, but ONLY when contact.status === "Approved" (credit gate).
//      The tagger itself self-limits to Team/EIR coaches, so Board/others no-op. Runs first, so
//      fresh service_areas + stops are on the GHL contact BEFORE we push to Wix.
//   2. SYNC — run every enabled contact Wix mapping set; each set's contact.status gate decides
//      upsert / update / hide / skip and does the Published write-back. Equality-guarded (idempotent).

import { getContact } from '../ghl/contacts';
import { GhlClient, ghl } from '../ghl/client';
import { enrichContact, readContactField } from '../enrichment/contactEngine';
import { readinessTagger } from '../enrichment/enrichers/readinessTagger';
import { hasAnthropic } from '../ai/anthropic';
import { getWixStore } from '../mapping/wixStore';
import { getWixCollectionSchema } from '../wix/catalogCache';
import { syncContactToWix } from './sync';
import type { CustomFieldCatalog } from '../ghl/types';

/** contact.status values that (re-)trigger enrichment. Matches the set gate's `upsert` value. */
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

  // 1) Enrich (credit-gated on status).
  const enrich: ContactTeamPipelineResult['enrich'] = { ran: false };
  if (!contact) {
    enrich.note = 'contact not found';
  } else if (ENRICH_ON_STATUS.has(status) && hasAnthropic) {
    const er = await enrichContact(contactId, [readinessTagger], contactCatalog, { mode: 'overwrite' }, { apply: opts.apply, client: gclient });
    enrich.ran = true;
    enrich.applied = er.applied.map((a) => a.contactKey);
  } else {
    enrich.note = !hasAnthropic ? 'ANTHROPIC_API_KEY not set' : `status "${status}" not in {${Array.from(ENRICH_ON_STATUS).join(',')}}`;
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
