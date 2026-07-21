// scripts-ts/geo-apply-from-preview.ts — apply already-computed geo classifications WITHOUT
// re-geocoding. Reads a preview jsonl (id + new label), writes the company field via the tested
// coercing writer (label→option key), then fans the value DOWN to the company's contacts via the
// geo-only company-to-contacts connection. No Census calls → reliable + fast. Idempotent
// (equality-guarded) + resumable (checkpoint).
//
//   npx vite-node scripts-ts/geo-apply-from-preview.ts --preview <path> --apply --yes [--resume]

import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getBusinessFieldCatalog } from '../lib/ghl/customFields';
import { setBusinessFields } from '../lib/ghl/businesses';
import { loadPushConnection, COMPANY_TO_CONTACTS_SLUG } from '../lib/sync/orchestrate';
import { syncConnection } from '../lib/sync/apply';
import { enumerateAllContacts } from '../lib/ghl/contacts';
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
function arg(name: string): string | undefined { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; }
function flag(name: string): boolean { return process.argv.includes(`--${name}`); }

const norm = (v: unknown) => (v == null || v === '' ? '' : String(v).trim().toLowerCase());
// preview stores option LABELS; the company field stores KEYS — compare normalized.
const LABEL2KEY: Record<string, string> = {
  'hubzone': 'hubzone', 'opportunity zone': 'opportunity_zone',
  'hubzone + opportunity zone': 'hubzone_opportunity_zone', 'none': 'none',
};

async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let idx = 0; const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, async () => { while (idx < items.length) { await worker(items[idx++]); } }));
}

(async () => {
  loadEnvLocal();
  const apply = flag('apply');
  if (apply && !flag('yes')) { console.error('Refusing to APPLY without --yes.'); process.exit(1); }
  const previewPath = arg('preview')!;
  const concurrency = Number(arg('concurrency') ?? 6);
  const client = ghl();
  const reportsDir = join(process.cwd(), 'reports'); mkdirSync(reportsDir, { recursive: true });
  const ckptPath = join(reportsDir, `${arg('ckpt') ?? 'geo-preview-apply'}.jsonl`);
  const done = new Set<string>();
  if (flag('resume') && existsSync(ckptPath)) for (const l of readFileSync(ckptPath, 'utf8').split('\n')) { const id = l.trim(); if (id) done.add(id); }

  // Load preview rows (geocoded, changed) → target label per company.
  const rows: Array<{ id: string; label: string; current: unknown }> = [];
  for (const line of readFileSync(previewPath, 'utf8').split('\n')) {
    if (!line.trim()) continue; const o = JSON.parse(line);
    if (!o.geocoded) continue;
    const label = o.new as string;
    const curKey = norm(o.current) === '' ? '' : (norm(o.current) === 'none' ? 'none' : norm(o.current));
    if (LABEL2KEY[norm(label)] === curKey) continue; // already correct
    rows.push({ id: o.id, label, current: o.current });
  }
  const todo = rows.filter((r) => !done.has(r.id));
  console.log(`Changed rows: ${rows.length} | to process: ${todo.length} | ${apply ? 'APPLY' : 'DRY-RUN'}`);

  const business = await getBusinessFieldCatalog();
  const full = await loadPushConnection(COMPANY_TO_CONTACTS_SLUG);
  if (!full) throw new Error('company-to-contacts connection missing');
  const geoConn = { ...full, rows: full.rows.filter((r) => r.sourceKey === GEO_BUSINESS_KEY && r.targetKey === GEO_CONTACT_KEY) };

  // Enumerate ALL contacts ONCE and group by company, so each company's down-sync reuses this
  // roster instead of re-enumerating all ~1,400 contacts per company (the slow path). Cache the
  // roster to a file so chunked/resumed invocations don't re-enumerate every time.
  const rosterPath = join(reportsDir, `${arg('roster') ?? 'geo-contacts-roster'}.json`);
  let byCompanyObj: Record<string, string[]>;
  if (existsSync(rosterPath)) {
    byCompanyObj = JSON.parse(readFileSync(rosterPath, 'utf8'));
    console.log(`Roster (cached): ${Object.keys(byCompanyObj).length} companies with contacts`);
  } else {
    const allContacts = await enumerateAllContacts(client);
    byCompanyObj = {};
    for (const c of allContacts) { if (!c.businessId) continue; (byCompanyObj[c.businessId] ??= []).push(c.id); }
    appendFileSync(rosterPath, JSON.stringify(byCompanyObj));
    console.log(`Roster (fresh): ${allContacts.length} contacts, ${Object.keys(byCompanyObj).length} companies`);
  }
  const byCompany = new Map<string, string[]>(Object.entries(byCompanyObj));

  let coWrites = 0, contactWrites = 0, errors = 0;
  await runPool(todo, concurrency, async (r) => {
    try {
      if (apply) {
        // Write the company field (setBusinessFields coerces the label → option key).
        await setBusinessFields(r.id, { [GEO_BUSINESS_KEY.replace('business.', '')]: r.label }, business.byKey, client);
        coWrites++;
        // Fan the (now-correct) company value DOWN to its contacts (geo row only), reusing the roster.
        const roster = byCompany.get(r.id) ?? [];
        const down = await syncConnection(geoConn, r.id, { apply: true }, { resolveCounterpartIds: async () => roster }, client);
        contactWrites += down.forward.reduce((n, f) => n + f.written.length, 0);
      }
    } catch (e: any) {
      errors++; console.warn('  ERR', r.id, e?.message ?? e); return; // NOT marked done → retried on resume
    }
    appendFileSync(ckptPath, r.id + '\n');
  });

  console.log(`\n${apply ? 'APPLIED' : 'DRY-RUN'} | company writes=${coWrites} | contact writes=${contactWrites} | errors=${errors}`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e?.stack ?? e); process.exit(2); });
