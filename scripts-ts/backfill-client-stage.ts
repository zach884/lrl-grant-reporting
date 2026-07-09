// scripts-ts/backfill-client-stage.ts
// One-time backfill: create Client Stage Tracking records from each scored contact's
// scoring history (mined from "Stage Scoring" notes; falls back to the initial/current
// contact fields when a contact has no parseable notes), associated to the contact's
// company. Idempotent via (source_contact_id + rescore_date). Dry-run writes a review CSV.
//
//   npx vite-node scripts-ts/backfill-client-stage.ts               # dry-run (writes review CSV)
//   npx vite-node scripts-ts/backfill-client-stage.ts --limit 80    # dry-run, first 80 contacts
//   npx vite-node scripts-ts/backfill-client-stage.ts --apply --resume
//
// Env: GHL_TARGET (live|sandbox), tokens from .env.local.

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
import { ghl } from '../lib/ghl/client';
import { enumerateAllContacts, getContact, getContactNotes } from '../lib/ghl/contacts';
import { toGhlDate, resolveOptionLabel } from '../lib/ghl/coerce';
import { eventsFromNotes, StageEvent } from '../lib/stage/parseStageNotes';
import type { CustomFieldCatalog, CustomFieldDef } from '../lib/ghl/types';

const APPLY = process.argv.includes('--apply');
const RESUME = process.argv.includes('--resume');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? parseInt(process.argv[i + 1], 10) : Infinity; })();
const STAGE = 'custom_objects.business_stage';
const REPORT_DIR = join(process.cwd(), 'reports');
const MODE = APPLY ? 'apply' : 'dryrun';
const CSV = join(REPORT_DIR, `client_stage_backfill_${MODE}.csv`);
const CKPT = join(REPORT_DIR, `client_stage_backfill_${MODE}.checkpoint`);

const client = ghl();
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };

async function fetchCatalog(objectKey: string, isContact = false): Promise<CustomFieldCatalog> {
  // Contact catalog: locationId is IN the path (a query locationId is rejected 422).
  // Business/object catalog: needs locationId as a query param (autoLocation default).
  const path = isContact ? `/locations/${client.locationId}/customFields` : `/custom-fields/object-key/${objectKey}`;
  const d = await client.request<any>({ path, autoLocation: !isContact });
  const fields: CustomFieldDef[] = (d.customFields ?? d.fields ?? []).map((f: any) => ({
    id: f.id, name: f.name, fieldKey: f.fieldKey ?? f.key ?? '', dataType: f.dataType,
    options: (f.options ?? f.picklistOptions ?? []).map((o: any) => typeof o === 'string' ? { key: o, label: o } : { key: o.key ?? o.id, label: o.label ?? o.name }),
  }));
  const byKey: Record<string, CustomFieldDef> = {}; const byId: Record<string, CustomFieldDef> = {};
  for (const f of fields) { byKey[f.fieldKey] = f; byId[f.id] = f; }
  return { fields, folders: [], byKey, byId };
}

/** Load existing stage records -> set of "contactId|YYYY-MM-DD" already present (dedup). */
async function loadExistingKeys(): Promise<Set<string>> {
  const keys = new Set<string>(); let page = 1;
  for (;;) {
    const d = await client.request<any>({ method: 'POST', path: `/objects/${STAGE}/records/search`, autoLocation: false, body: { locationId: client.locationId, page, pageLimit: 100 } });
    const recs: any[] = d.records ?? d.data ?? [];
    if (recs.length === 0) break;
    for (const r of recs) {
      const p = r.properties ?? {};
      if (p.source_contact_id && p.rescore_date) keys.add(`${p.source_contact_id}|${String(p.rescore_date).slice(0, 10)}`);
    }
    if (recs.length < 100) break; page++;
  }
  return keys;
}

/** Build stage events from a contact: notes first, else initial/current fields. */
function fieldFallbackEvents(cf: Record<string, unknown>, cat: CustomFieldCatalog): StageEvent[] {
  const g = (key: string) => cf[cat.byKey[key]?.id ?? ''];
  const cur: StageEvent = {
    date: (g('contact.business_stage_rescored_date') as string) || new Date().toISOString(),
    churchill: num(g('contact.churchill_current')), substage: (g('contact.churchill_substage_current') as string) ?? null,
    trl: num(g('contact.trl_current')), mrl: num(g('contact.mrl_current')), crl: num(g('contact.crl_current')),
    rationale: [g('contact.latest_churchill_stage_rationale'), g('contact.latest_tech_stage_rationale')].filter(Boolean).join('\n\n---\n\n'),
    snapshotKind: 'Current', noteIds: [],
  };
  const init: StageEvent = {
    date: (g('contact.date_of_initial_intake') as string) || cur.date,
    churchill: num(g('contact.churchill_initial')), substage: (g('contact.churchill_substage_initial') as string) ?? null,
    trl: num(g('contact.trl_initial')), mrl: num(g('contact.mrl_initial')), crl: num(g('contact.crl_initial')),
    rationale: '', snapshotKind: 'Initial', noteIds: [],
  };
  const has = (e: StageEvent) => [e.churchill, e.trl, e.mrl, e.crl].some((v) => v != null);
  const same = init.churchill === cur.churchill && init.trl === cur.trl && init.mrl === cur.mrl && init.crl === cur.crl;
  const out: StageEvent[] = [];
  if (has(init) && !same) out.push(init);
  if (has(cur)) out.push(cur);
  return out;
}

function csvCell(v: unknown) { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

async function main() {
  const [contactCat, stageCat] = await Promise.all([fetchCatalog('contact', true), fetchCatalog(STAGE)]);
  const methodOpts = stageCat.byKey[`${STAGE}.rescore_method`]?.options;
  const kindOpts = stageCat.byKey[`${STAGE}.snapshot_kind`]?.options;
  // association id for company <-> client stage
  const assocs = await client.request<any>({ path: '/associations/', params: { limit: 100 } });
  const assocId = (assocs.associations ?? []).find((a: any) => a.key === 'company_business_stage')?.id;
  if (!assocId) throw new Error('company_business_stage association not found');

  const existing = await loadExistingKeys();
  const done = RESUME && existsSync(CKPT) ? new Set(readFileSync(CKPT, 'utf8').split('\n').filter(Boolean)) : new Set<string>();

  // Write the header only on a fresh run; when resuming, append to the existing CSV.
  if (!(RESUME && existsSync(CSV))) {
    writeFileSync(CSV, 'contactId,contactName,companyId,snapshot_kind,rescore_date,churchill,substage,trl,mrl,crl,action,valid_vs_fields\n');
  }

  const scoreKeys = ['contact.churchill_current', 'contact.trl_current', 'contact.mrl_current', 'contact.crl_current',
    'contact.churchill_initial', 'contact.trl_initial', 'contact.mrl_initial', 'contact.crl_initial'];
  const scoreIds = scoreKeys.map((k) => contactCat.byKey[k]?.id).filter(Boolean) as string[];

  // Page contacts up to LIMIT, tolerating transient 400s on nextPageUrl (retry).
  async function collectContacts(max: number): Promise<Array<{ id: string }>> {
    const out: any[] = []; let url: string | undefined; let first = true;
    while (out.length < max) {
      let d: any;
      for (let a = 0; a < 4; a++) {
        try { d = first ? await client.request<any>({ path: '/contacts/', params: { limit: 100 } }) : await client.request<any>({ path: url!, autoLocation: false }); break; }
        catch (e) { if (a === 3) throw e; await new Promise((r) => setTimeout(r, 800 * (a + 1))); }
      }
      first = false;
      const cs: any[] = d.contacts ?? [];
      if (!cs.length) break;
      out.push(...cs);
      url = d.meta?.nextPageUrl;
      if (!url) break;
    }
    return out.slice(0, max);
  }
  const all = await collectContacts(LIMIT);
  let processed = 0, scored = 0, created = 0, skippedDup = 0, noCompany = 0, mismatches = 0;

  for (const lite of all) {
    if (processed >= LIMIT) break;
    if (done.has(lite.id)) continue;
    processed++;
    const c = await getContact(lite.id, client);
    if (!c) continue;
    const cf: Record<string, unknown> = {};
    for (const x of c.customFields ?? []) cf[x.id] = x.value;
    const isScored = scoreIds.some((id) => cf[id] != null && cf[id] !== '');
    if (!isScored) { if (RESUME) appendFileSync(CKPT, lite.id + '\n'); continue; }
    scored++;

    if (!c.businessId) { noCompany++; if (RESUME) appendFileSync(CKPT, lite.id + '\n'); continue; }

    let events: StageEvent[] = [];
    try { events = eventsFromNotes(await getContactNotes(lite.id, client)); } catch { /* notes fetch failed */ }
    const source = events.length ? 'notes' : 'fields';
    if (!events.length) events = fieldFallbackEvents(cf, contactCat);

    // validation: latest parsed vs *_current fields (all metrics, null-tolerant —
    // only flag when a non-null parsed value disagrees with a non-empty field value).
    const latest = events[events.length - 1];
    const vs = (parsed: number | null, fieldVal: unknown) =>
      parsed == null || fieldVal == null || fieldVal === '' ? true : num(fieldVal) === parsed;
    const curOk = !latest || (
      vs(latest.churchill, cf[contactCat.byKey['contact.churchill_current']?.id ?? '']) &&
      vs(latest.trl, cf[contactCat.byKey['contact.trl_current']?.id ?? '']) &&
      vs(latest.mrl, cf[contactCat.byKey['contact.mrl_current']?.id ?? '']) &&
      vs(latest.crl, cf[contactCat.byKey['contact.crl_current']?.id ?? '']));
    if (!curOk) mismatches++;

    const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.companyName || lite.id;
    for (const e of events) {
      const dedupKey = `${lite.id}|${String(e.date).slice(0, 10)}`;
      if (existing.has(dedupKey)) { skippedDup++; continue; }
      const action = APPLY ? 'created' : 'would-create';
      appendFileSync(CSV, [lite.id, name, c.businessId, e.snapshotKind, String(e.date).slice(0, 10),
        e.churchill, e.substage, e.trl, e.mrl, e.crl, `${action}(${source})`, curOk ? 'ok' : 'MISMATCH'].map(csvCell).join(',') + '\n');
      if (!APPLY) continue;

      const props: Record<string, unknown> = {
        name: `${name} — ${e.snapshotKind} ${String(e.date).slice(0, 10)}`,
        source_contact_id: lite.id,
        snapshot_kind: resolveOptionLabel(e.snapshotKind, kindOpts) ?? e.snapshotKind,
        rescore_date: toGhlDate(e.date),
        rescore_method: resolveOptionLabel((cf[contactCat.byKey['contact.business_stage_rescored_method']?.id ?? ''] as string) || 'AI', methodOpts) ?? 'AI',
        stage_rationale: e.rationale || undefined,
      };
      if (e.churchill != null) props.churchill_score = e.churchill;
      if (e.substage != null) props.churchill_substage = e.substage;
      if (e.trl != null) props.trl = e.trl;
      if (e.mrl != null) props.mrl = e.mrl;
      if (e.crl != null) props.crl = e.crl;
      if (e.snapshotKind === 'Current') { const t = num(cf[contactCat.byKey['contact.total_business_stage_advancement']?.id ?? '']); if (t != null) props.total_business_stage_advancement = t; }
      for (const k of Object.keys(props)) if (props[k] === undefined) delete props[k];

      const rec = await client.request<any>({ method: 'POST', path: `/objects/${STAGE}/records`, autoLocation: false, body: { locationId: client.locationId, properties: props } });
      const rid = rec.record?.id ?? rec.id;
      if (rid) {
        await client.request({ method: 'POST', path: '/associations/relations', autoLocation: false, body: { locationId: client.locationId, associationId: assocId, firstRecordId: c.businessId, secondRecordId: rid } });
        created++;
        existing.add(dedupKey);
      }
    }
    if (RESUME) appendFileSync(CKPT, lite.id + '\n');
    if (processed % 50 === 0) console.log(`  ...processed ${processed} contacts (scored ${scored}, created ${created})`);
  }

  console.log(`\n${APPLY ? 'APPLY' : 'DRY-RUN'} done. contacts processed=${processed} scored=${scored} no-company=${noCompany} records ${APPLY ? 'created' : 'would-create'}=${created || '(see CSV)'} skipped-dup=${skippedDup} validation-mismatches=${mismatches}`);
  console.log(`review CSV: ${CSV}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
