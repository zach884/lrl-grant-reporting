// scripts-ts/converge-business-stage.ts — ONE-TIME convergence of the 20 business-stage-tracking
// fields so every company AND all its contacts hold the SAME, FRESHEST snapshot.
//
// Why: business-stage sync is disabled in the map (a contact-side re-scoring automation owns these
// fields), so company/contacts have drifted. Before those fields graduate to a dedicated
// BusinessStageTracking custom object, we want ONE authoritative snapshot per company to seed from.
//
// Freshness signal = business_stage_rescored_date (the domain "when last scored" date). Per company
// group, the record (company or any contact) with the MAX rescored_date wins; its snapshot is
// written to the company and every contact. Groups where NO record has a rescored_date are skipped
// (nothing authoritative to converge) and reported.
//
//   npx vite-node scripts-ts/converge-business-stage.ts                  # DRY-RUN, all
//   npx vite-node scripts-ts/converge-business-stage.ts --limit 120 --resume
//   npx vite-node scripts-ts/converge-business-stage.ts --apply --yes --resume
//
// Target via GHL_TARGET (default live). Reads .env.local.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
import { getBusinessFieldCatalog, getContactFieldCatalog } from '../lib/ghl/customFields';
import { getBusinessRecord, setBusinessFields } from '../lib/ghl/businesses';
import { getContact, enumerateAllContacts, setContactCustomFields } from '../lib/ghl/contacts';
import { optionKeyToLabel } from '../lib/ghl/coerce';
import { coerceContactCustomFields } from '../lib/ghl/coerceContact';
import { valuesEqual } from '../lib/sync/downsync';
import { FileReconcileCheckpoint } from '../lib/sync/reconcile';
import type { CustomFieldCatalog, Contact } from '../lib/ghl/types';

function loadEnvLocal() {
  try {
    for (const line of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* ok */ }
}
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const flag = (n: string) => process.argv.includes(`--${n}`);
const bare = (k: string) => k.replace(/^business\./, '');

interface Pair { contactKey: string; businessKey: string; }

(async () => {
  loadEnvLocal();
  const apply = flag('apply');
  if (apply && !flag('yes')) { console.error('Refusing to APPLY without --yes.'); process.exit(1); }
  const target = process.env.GHL_TARGET ?? 'live';
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const client = ghl();

  // The 20 business-stage pairs = disabled rows tagged for the future object.
  const mapDoc = JSON.parse(readFileSync(join(process.cwd(), 'config/field-mappings.json'), 'utf8'));
  const pairs: Pair[] = mapDoc.mappings
    .filter((m: any) => (m.note ?? '').includes('future BusinessStageTracking object'))
    .map((m: any) => ({ contactKey: m.contactKey, businessKey: m.businessKey }));
  const FRESH_B = 'business.business_stage_rescored_date';
  const FRESH_C = 'contact.business_stage_rescored_date';
  console.log(`Converge business-stage | target=${target} | ${apply ? 'APPLY' : 'DRY-RUN'} | ${pairs.length} fields` + (limit ? ` | limit=${limit}` : ''));

  const [bCat, cCat]: [CustomFieldCatalog, CustomFieldCatalog] =
    await Promise.all([getBusinessFieldCatalog(client), getContactFieldCatalog(client)]);

  // Canonical snapshot = LABEL form keyed by businessKey bare. Company values are stored as
  // option KEYS -> convert to labels; contact values already read back as labels.
  const companySnapshot = (props: Record<string, unknown>) => {
    const snap: Record<string, unknown> = {};
    for (const p of pairs) {
      const def = bCat.byKey[p.businessKey];
      const raw = props[bare(p.businessKey)];
      if (raw == null || raw === '') continue;
      snap[p.businessKey] = def?.options?.length ? optionKeyToLabel(raw, def.options) : raw;
    }
    return snap;
  };
  const contactSnapshot = (contact: Contact) => {
    const byId = new Map<string, unknown>();
    for (const cf of contact.customFields ?? []) byId.set(cf.id, cf.value);
    const snap: Record<string, unknown> = {};
    for (const p of pairs) {
      const id = cCat.byKey[p.contactKey]?.id;
      const v = id ? byId.get(id) : undefined;
      if (v == null || v === '') continue;
      snap[p.businessKey] = v; // already label-ish on the contact side
    }
    return snap;
  };
  const freshOf = (snap: Record<string, unknown>) => String(snap[FRESH_B] ?? '');

  const reportsDir = join(process.cwd(), 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const cp = flag('resume') ? new FileReconcileCheckpoint(join(reportsDir, `checkpoint-bizstage-${target}-${apply ? 'apply' : 'dryrun'}.jsonl`)) : undefined;
  const done = cp ? await cp.loadDone() : new Set<string>();

  const all = await enumerateAllContacts(client);
  const byCompany = new Map<string, Contact[]>();
  for (const c of all) { if (!c.businessId) continue; (byCompany.get(c.businessId) ?? byCompany.set(c.businessId, []).get(c.businessId)!).push(c); }

  let entries = Array.from(byCompany.entries()).filter(([id]) => !done.has(id));
  if (limit != null) entries = entries.slice(0, limit);

  const stats = { groups: 0, converged: 0, skippedNoDate: 0, companyWrites: 0, contactWrites: 0, errors: 0 };
  const log: any[] = [];

  for (const [companyId, contacts] of entries) {
    stats.groups++;
    try {
      const company = await getBusinessRecord(companyId, client);
      if (!company) { if (cp) await cp.markDone(companyId); continue; }
      const fulls: Contact[] = [];
      for (const c of contacts) fulls.push((await getContact(c.id, client)) ?? c);

      // Build candidate snapshots with freshness.
      const candidates: Array<{ source: string; date: string; snap: Record<string, unknown> }> = [];
      const coSnap = companySnapshot(company.properties);
      candidates.push({ source: 'company', date: freshOf(coSnap), snap: coSnap });
      for (const c of fulls) {
        const s = contactSnapshot(c);
        candidates.push({ source: `contact:${c.id}`, date: freshOf(s), snap: s });
      }
      const dated = candidates.filter((c) => c.date);
      if (dated.length === 0) { stats.skippedNoDate++; if (cp) await cp.markDone(companyId); continue; }
      dated.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      const winner = dated[0];

      // Diff + write company.
      const coWrites: Record<string, unknown> = {};
      for (const p of pairs) {
        const want = winner.snap[p.businessKey];
        if (want == null || want === '') continue;
        const def = bCat.byKey[p.businessKey];
        const curLabel = def?.options?.length ? optionKeyToLabel(company.properties[bare(p.businessKey)], def.options) : company.properties[bare(p.businessKey)];
        if (!valuesEqual(curLabel, want)) coWrites[p.businessKey] = want;
      }
      // Diff + write each contact.
      const contactPlans: Array<{ id: string; fields: Array<{ id: string; value: unknown }> }> = [];
      for (const c of fulls) {
        const desiredByContactKey: Record<string, unknown> = {};
        for (const p of pairs) { const w = winner.snap[p.businessKey]; if (w != null && w !== '') desiredByContactKey[p.contactKey] = w; }
        const { fields } = coerceContactCustomFields(desiredByContactKey, cCat);
        const byId = new Map<string, unknown>();
        for (const cf of c.customFields ?? []) byId.set(cf.id, cf.value);
        const changed = fields.filter((f) => !valuesEqual(byId.get(f.id), f.value));
        if (changed.length) contactPlans.push({ id: c.id, fields: changed });
      }

      if (Object.keys(coWrites).length || contactPlans.length) {
        stats.converged++;
        log.push({ companyId, companyName: company.properties['name'], winner: winner.source, date: winner.date,
          companyFields: Object.keys(coWrites).length, contactsChanged: contactPlans.length });
        if (apply) {
          if (Object.keys(coWrites).length) { await setBusinessFields(companyId, coWrites, bCat.byKey, client); stats.companyWrites += Object.keys(coWrites).length; }
          for (const cpl of contactPlans) { await setContactCustomFields(cpl.id, cpl.fields, client); stats.contactWrites += cpl.fields.length; }
        } else {
          stats.companyWrites += Object.keys(coWrites).length;
          stats.contactWrites += contactPlans.reduce((n, p) => n + p.fields.length, 0);
        }
      }
      if (cp) await cp.markDone(companyId);
    } catch (e: any) {
      stats.errors++;
      log.push({ companyId, error: e?.message ?? String(e) });
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(reportsDir, `bizstage-converge-${target}-${apply ? 'apply' : 'dryrun'}-${stamp}.json`), JSON.stringify({ stats, log }, null, 2));
  console.log(`groups ${stats.groups} | converged ${stats.converged} | skipped(no date) ${stats.skippedNoDate} | errors ${stats.errors}`);
  console.log(`company fields ${apply ? 'written' : 'would write'}: ${stats.companyWrites} | contact fields: ${stats.contactWrites}`);
  console.log('winners (up to 15):');
  for (const r of log.filter((r) => r.winner).slice(0, 15)) console.log(`  ${String(r.companyName).slice(0, 30).padEnd(30)} src=${r.winner} date=${r.date} co=${r.companyFields} contacts=${r.contactsChanged}`);
})().catch((e) => { console.error('CONVERGE FAILED:', e?.stack ?? e); process.exit(2); });
