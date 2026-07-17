// READ-ONLY parity harness: old built-in engine vs new generic push connections.
// Compares PLANNED writes (dry-run, no writes) per entity, per direction, and categorizes diffs.
//
//   npx vite-node scripts-ts/parity-check.ts [--limit N] [--all]
//
// UP   (contact→company): old syncContactUp  vs  contact-to-company dry-run
// DOWN (company→contacts): old syncCompanyDown vs company-to-contacts dry-run

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
import { enumerateAllContacts } from '../lib/ghl/contacts';
import { getBusinessFieldCatalog, getContactFieldCatalog } from '../lib/ghl/customFields';
import { mappingStore } from '../lib/mapping';
import { DbMappingStore } from '../lib/mapping/dbStore';
import { syncContactUp, syncCompanyDown } from '../lib/sync';
import { planConnectionDryRun, type DryRunConnection } from '../lib/sync/dryrun';
import type { CustomFieldCatalog } from '../lib/ghl/types';

function loadEnvLocal() {
  const txt = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const bareBiz = (k: string) => k.replace(/^business\./, '');
const norm = (v: unknown) => Array.isArray(v) ? Array.from(v).map(String).sort().join('|') : String(v ?? '').trim();
const tolerantEqual = (a: unknown, b: unknown) => norm(a).toLowerCase() === norm(b).toLowerCase();

interface Diff { entity: string; dir: 'up' | 'down'; contactId?: string; field: string; kind: 'only-new' | 'only-old' | 'value'; oldVal?: unknown; newVal?: unknown; dataType?: string; hold?: boolean; transform?: string; }

(async () => {
  loadEnvLocal();
  const args = process.argv.slice(2);
  const limit = args.includes('--all') ? Infinity : Number(args[args.indexOf('--limit') + 1]) || 15;
  const client = ghl();

  const [{ mappings }, business, contact] = await Promise.all([mappingStore.load(), getBusinessFieldCatalog(), getContactFieldCatalog()]);
  const catalogs = { business, contact };
  // Row metadata for categorizing diffs (by bare company key / by contact key).
  const holdByBiz = new Set(mappings.filter((m) => m.holdValues?.length).map((m) => bareBiz(m.businessKey)));
  const holdByContact = new Set(mappings.filter((m) => m.holdValues?.length).map((m) => m.contactKey));
  const xformByBiz = new Map(mappings.filter((m) => m.transform).map((m) => [bareBiz(m.businessKey), m.transform!] as const));

  const store = mappingStore as DbMappingStore;
  const c2cMeta = await store.getSyncMeta('contact-to-company');
  const co2cMeta = await store.getSyncMeta('company-to-contacts');
  const c2cSet = await store.loadSync('contact-to-company');
  const co2cSet = await store.loadSync('company-to-contacts');
  const toRows = (s: typeof c2cSet) => s.mappings.map((m) => ({ sourceKey: m.contactKey, targetKey: m.businessKey, direction: m.direction, transform: m.transform, enabled: m.enabled, holdValues: m.holdValues }));
  const c2cConn: DryRunConnection = { sourceObject: c2cMeta!.sourceObject, targetObject: c2cMeta!.destObject, associationId: c2cMeta!.associationId!, rows: toRows(c2cSet) };
  const co2cConn: DryRunConnection = { sourceObject: co2cMeta!.sourceObject, targetObject: co2cMeta!.destObject, associationId: co2cMeta!.associationId!, rows: toRows(co2cSet) };

  // Group contacts by company (scalar businessId) — same roster both engines use.
  const all = await enumerateAllContacts(client);
  const byCompany = new Map<string, string[]>();
  for (const c of all) { const b = (c as any).businessId; if (b) { if (!byCompany.has(b)) byCompany.set(b, []); byCompany.get(b)!.push(c.id); } }
  const companies = Array.from(byCompany.keys()).slice(0, limit === Infinity ? undefined : limit);
  console.log(`Comparing ${companies.length} companies (${companies.reduce((s, c) => s + byCompany.get(c)!.length, 0)} contacts). limit=${limit}\n`);

  const diffs: Diff[] = [];
  const fieldKeyById = (id: string) => contact.byId[id]?.fieldKey ?? id;

  let n = 0;
  for (const companyId of companies) {
    n++;
    const contactIds = byCompany.get(companyId)!;

    // ---- UP: each contact → its company ----
    for (const cid of contactIds) {
      const [oldUp, newUp] = await Promise.all([
        syncContactUp(cid, mappings, catalogs, { apply: false, client }),
        planConnectionDryRun(c2cConn, cid),
      ]);
      const oldMap = new Map(oldUp.drift.map((d) => [bareBiz(d.field), d.to]));
      const newMap = new Map((newUp.counterparts[0]?.changes ?? []).map((c) => [bareBiz(c.targetKey), c.to]));
      for (const k of Array.from(new Set(Array.from(oldMap.keys()).concat(Array.from(newMap.keys()))))) {
        const inOld = oldMap.has(k), inNew = newMap.has(k);
        const meta = { dataType: business.byKey[`business.${k}`]?.dataType, hold: holdByBiz.has(k), transform: xformByBiz.get(k) };
        if (inOld && !inNew) diffs.push({ entity: companyId, dir: 'up', contactId: cid, field: k, kind: 'only-old', oldVal: oldMap.get(k), ...meta });
        else if (!inOld && inNew) diffs.push({ entity: companyId, dir: 'up', contactId: cid, field: k, kind: 'only-new', newVal: newMap.get(k), ...meta });
        else if (!tolerantEqual(oldMap.get(k), newMap.get(k))) diffs.push({ entity: companyId, dir: 'up', contactId: cid, field: k, kind: 'value', oldVal: oldMap.get(k), newVal: newMap.get(k), ...meta });
      }
    }

    // ---- DOWN: company → its contacts ----
    const [oldDown, newDown] = await Promise.all([
      syncCompanyDown(companyId, mappings, catalogs, { apply: false, client }),
      planConnectionDryRun(co2cConn, companyId),
    ]);
    const newByContact = new Map(newDown.counterparts.map((cp) => [cp.targetId, new Map(cp.changes.map((c) => [c.targetKey, c.to]))]));
    for (const res of oldDown.results) {
      const oldMap = new Map<string, unknown>();
      for (const d of res.drift) oldMap.set(fieldKeyById(String(d.field)), d.to);
      const newMap = newByContact.get(res.contactId) ?? new Map();
      for (const k of Array.from(new Set(Array.from(oldMap.keys()).concat(Array.from(newMap.keys()))))) {
        const inOld = oldMap.has(k), inNew = newMap.has(k);
        const meta = { dataType: contact.byKey[k]?.dataType, hold: holdByContact.has(k), transform: mappings.find((m) => m.contactKey === k)?.transform };
        if (inOld && !inNew) diffs.push({ entity: companyId, dir: 'down', contactId: res.contactId, field: k, kind: 'only-old', oldVal: oldMap.get(k), ...meta });
        else if (!inOld && inNew) diffs.push({ entity: companyId, dir: 'down', contactId: res.contactId, field: k, kind: 'only-new', newVal: newMap.get(k), ...meta });
        else if (!tolerantEqual(oldMap.get(k), newMap.get(k))) diffs.push({ entity: companyId, dir: 'down', contactId: res.contactId, field: k, kind: 'value', oldVal: oldMap.get(k), newVal: newMap.get(k), ...meta });
      }
    }
    if (n % 5 === 0) console.log(`  …${n}/${companies.length} companies, ${diffs.length} diffs so far`);
  }

  // ---- Report ----
  console.log(`\n===== PARITY REPORT: ${diffs.length} field-level diffs =====`);
  const cat = (d: Diff) => `${d.dir}/${d.kind}/${d.hold ? 'holdValues' : d.transform ? 'transform:' + d.transform : d.dataType ?? 'scalar'}`;
  const groups = new Map<string, Diff[]>();
  for (const d of diffs) { const k = cat(d); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(d); }
  for (const [k, ds] of Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n[${ds.length}] ${k}`);
    for (const d of ds.slice(0, 3)) console.log(`    ${d.field} (contact ${d.contactId?.slice(0, 8)}): old=${JSON.stringify(d.oldVal)} new=${JSON.stringify(d.newVal)}`);
    if (ds.length > 3) console.log(`    …+${ds.length - 3} more`);
  }
  if (!diffs.length) console.log('\n✅ ZERO diffs — the generic engine matches the built-in engine on this sample.');
  process.exit(0);
})();
