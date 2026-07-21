// scripts-ts/geo-batch.ts — batch the Geographically Disadvantaged enrichment across all
// companies that have an address, then fan the value DOWN to each company's contacts.
//
//   npx vite-node scripts-ts/geo-batch.ts                       # DRY-RUN, all with-address companies
//   npx vite-node scripts-ts/geo-batch.ts --blanks-only         # DRY-RUN, only companies with blank geo
//   npx vite-node scripts-ts/geo-batch.ts --limit 25            # DRY-RUN, first 25
//   npx vite-node scripts-ts/geo-batch.ts --apply --yes         # APPLY (writes company + contacts)
//   npx vite-node scripts-ts/geo-batch.ts --apply --yes --resume
//
// ONLY the geo-zone enricher runs (no county/NAICS). Down-sync uses the company-to-contacts push
// connection but filtered to JUST the geo mapping row, so nothing else on the contact is touched.
// Idempotent + equality-guarded end to end. Reads .env.local.

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBusinessFieldCatalog } from '../lib/ghl/customFields';
import { enrichCompany, geoZoneEnricher } from '../lib/enrichment';
import { loadPushConnection, COMPANY_TO_CONTACTS_SLUG } from '../lib/sync/orchestrate';
import { syncConnection } from '../lib/sync/apply';
import { ghl } from '../lib/ghl/client';

const GEO_BUSINESS_KEY = 'business.geo_disadvantaged';
const GEO_CONTACT_KEY = 'contact.geographically_disadvantaged';

function loadEnvLocal() {
  try {
    const txt = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* ok */ }
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean { return process.argv.includes(`--${name}`); }

function hasAddress(p: Record<string, any>): boolean {
  return Boolean((p.address && String(p.address).trim()) || (p.city && p.state) || p.postalcode);
}

/** Enumerate ALL business records via the objects search endpoint (authoritative properties). */
async function listAllBusinessRecords(client = ghl()): Promise<Array<{ id: string; name?: string; properties: Record<string, any> }>> {
  const out: Array<{ id: string; name?: string; properties: Record<string, any> }> = [];
  for (let page = 1; page <= 60; page++) {
    const d = await client.request<any>({
      path: '/objects/business/records/search',
      method: 'POST',
      autoLocation: false,
      body: { locationId: process.env.GHL_LOCATION_ID, page, pageLimit: 100 },
    });
    const recs: any[] = d.records ?? [];
    if (!recs.length) break;
    for (const r of recs) out.push({ id: r.id, name: r.properties?.name, properties: r.properties ?? {} });
    if (recs.length < 100) break;
  }
  return out;
}

async function runPool<T>(items: T[], limit: number, worker: (item: T, i: number) => Promise<void>) {
  let idx = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    while (idx < items.length) { const i = idx++; await worker(items[i], i); }
  }));
}

(async () => {
  loadEnvLocal();
  const apply = flag('apply');
  const yes = flag('yes');
  if (apply && !yes) {
    console.error('Refusing to APPLY without --yes. This writes to company + contact records. Re-run with --apply --yes.');
    process.exit(1);
  }
  const target = process.env.GHL_TARGET ?? 'live';
  const concurrency = Number(arg('concurrency') ?? 5);
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const blanksOnly = flag('blanks-only');
  const minConfidence = arg('min-confidence') ? Number(arg('min-confidence')) : 0.7;
  const client = ghl();

  const reportsDir = join(process.cwd(), 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tag = `${target}-${apply ? 'apply' : 'dryrun'}-${stamp}`;

  const ckptName = arg('ckpt') ?? `geo-batch-checkpoint-${target}-${apply ? 'apply' : 'dryrun'}`;
  const ckptPath = join(reportsDir, `${ckptName}.jsonl`);
  const done = new Set<string>();
  if (flag('resume') && existsSync(ckptPath)) {
    for (const line of readFileSync(ckptPath, 'utf8').split('\n')) { const id = line.trim(); if (id) done.add(id); }
  }

  console.log(`GEO-BATCH ${apply ? 'APPLY' : 'DRY-RUN'} | target=${target} | concurrency=${concurrency} | minConf=${minConfidence}` +
    (blanksOnly ? ' | blanks-only' : '') + (limit ? ` | limit=${limit}` : ''));

  // Build the geo-ONLY down-sync connection (company-to-contacts filtered to the geo row).
  const full = await loadPushConnection(COMPANY_TO_CONTACTS_SLUG);
  if (!full) throw new Error(`${COMPANY_TO_CONTACTS_SLUG} connection not configured`);
  const geoRows = full.rows.filter((r) => r.sourceKey === GEO_BUSINESS_KEY && r.targetKey === GEO_CONTACT_KEY);
  if (!geoRows.length) throw new Error('No geo mapping row found in company-to-contacts connection');
  if (geoRows[0].enabled === false) console.warn('⚠️  geo mapping row is DISABLED — down-sync would skip it.');
  const geoConn = { ...full, rows: geoRows };

  const business = await getBusinessFieldCatalog();
  let companies = await listAllBusinessRecords(client);
  companies = companies.filter((c) => hasAddress(c.properties));
  if (blanksOnly) {
    companies = companies.filter((c) => {
      const g = c.properties?.geo_disadvantaged;
      return g == null || g === '';
    });
  }
  if (limit) companies = companies.slice(0, limit);
  const todo = companies.filter((c) => !done.has(c.id));
  console.log(`Companies with address: ${companies.length} (${todo.length} to process, ${done.size} skipped via checkpoint)`);

  const valueDist: Record<string, number> = {};
  const rows: any[] = [];
  let processed = 0, companyWrites = 0, geocodeFail = 0, contactsChanged = 0, lastLog = Date.now();

  await runPool(todo, concurrency, async (co) => {
    try {
      const res = await enrichCompany(co.id, [geoZoneEnricher], business, { mode: 'overwrite', minConfidence }, { apply });
      const geoApplied = res.applied.find((a) => a.businessKey === GEO_BUSINESS_KEY);
      const proposal = res.proposals.find((p) => p.businessKey === GEO_BUSINESS_KEY);

      if (!proposal) { geocodeFail++; rows.push({ companyId: co.id, name: co.name, geocode: 'FAILED/none-returned' }); return; }
      valueDist[String(proposal.value)] = (valueDist[String(proposal.value)] ?? 0) + 1;

      if (geoApplied) {
        companyWrites++;
        // Down-sync geo → this company's contacts (geo row only).
        const down = await syncConnection(geoConn, co.id, { apply }, undefined, client);
        const cc = down.forward.filter((f) => (apply ? f.written.length : f.changes.length) > 0).length;
        contactsChanged += cc;
        rows.push({ companyId: co.id, name: co.name, wrote: proposal.value, from: geoApplied ? 'blank/overwrite' : undefined, contactsAffected: cc, contactCount: down.counterpartCount });
      }
    } catch (e: any) {
      rows.push({ companyId: co.id, name: co.name, error: e?.message ?? String(e) });
    } finally {
      processed++;
      if (apply) appendFileSync(ckptPath, co.id + '\n');
      if (Date.now() - lastLog > 2500 || processed === todo.length) {
        console.log(`  progress ${processed}/${todo.length} | company writes=${companyWrites} | geocode-fail=${geocodeFail}`);
        lastLog = Date.now();
      }
    }
  });

  const reportPath = join(reportsDir, `geo-batch-report-${tag}.json`);
  writeFileSync(reportPath, JSON.stringify({ target, apply, minConfidence, processed, companyWrites, geocodeFail, contactsChanged, valueDist, rows }, null, 2));
  console.log(`\n=== GEO-BATCH ${apply ? 'APPLIED' : 'DRY-RUN'} SUMMARY ===`);
  console.log(`Companies processed:        ${processed}`);
  console.log(`Company geo ${apply ? 'written' : 'would write'}:    ${companyWrites}`);
  console.log(`Geocode produced no value:  ${geocodeFail}`);
  console.log(`Contacts ${apply ? 'changed' : 'would change'}:        ${contactsChanged}`);
  console.log(`Proposed value distribution:`, JSON.stringify(valueDist));
  console.log(`Report: reports/geo-batch-report-${tag}.json`);
  process.exit(0);
})().catch((e) => { console.error('GEO-BATCH FAILED:', e?.stack ?? e); process.exit(2); });
