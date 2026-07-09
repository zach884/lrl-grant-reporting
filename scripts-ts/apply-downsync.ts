// scripts-ts/apply-downsync.ts — robust, resumable DOWN-sync apply for large live runs.
//
// Why this exists: the one-shot full-contact enumeration inside reconcileAll can hit a
// transient GHL page timeout (returned as 400) that aborts the whole run before any
// company is processed. This script (a) enumerates ALL contacts ONCE with per-page retry
// and caches them to reports/contacts-cache.json, then (b) runs the checkpointed
// reconcile off that cache — so chained passes never re-enumerate and a flaky page can't
// nuke the run.
//
//   npx vite-node scripts-ts/apply-downsync.ts --dry            # dry-run off the cache
//   npx vite-node scripts-ts/apply-downsync.ts --apply --yes    # APPLY (writes to contacts)
//   flags: --refresh (re-fetch contact cache) --concurrency N --ckpt NAME
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
import { getBusinessFieldCatalog, getContactFieldCatalog } from '../lib/ghl/customFields';
import { mappingStore } from '../lib/mapping';
import { reconcileAll, writeReconcileReport, FileReconcileCheckpoint } from '../lib/sync/reconcile';
import type { Contact } from '../lib/ghl/types';

function loadEnv() {
  const txt = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const flag = (n: string) => process.argv.includes(`--${n}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Enumerate all contacts with PER-PAGE retry (handles the transient 400/timeout page). */
async function enumerateWithRetry(): Promise<Contact[]> {
  const client = ghl();
  const out: Contact[] = [];
  let url: string | undefined;
  let first = true;
  for (;;) {
    let data: any = null;
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        data = first
          ? await client.request<any>({ path: '/contacts/', params: { limit: 100 } })
          : await client.request<any>({ path: url as string, autoLocation: false });
        break;
      } catch (e: any) {
        if (attempt === 6) throw e;
        const wait = 1500 * attempt;
        console.log(`   page retry ${attempt} after error: ${String(e?.message ?? e).slice(0, 80)} (wait ${wait}ms)`);
        await sleep(wait);
      }
    }
    first = false;
    const batch: any[] = data.contacts ?? [];
    for (const c of batch) out.push({
      id: c.id, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone,
      companyName: c.companyName, businessId: c.businessId ?? c.companyId,
      address1: c.address1, city: c.city, state: c.state, postalCode: c.postalCode, country: c.country,
      website: c.website, customFields: c.customFields,
    });
    if (batch.length === 0) break;
    const next: string | undefined = data.meta?.nextPageUrl;
    if (!next) break;
    url = next;
    if (out.length % 300 === 0) console.log(`   ...enumerated ${out.length} contacts`);
  }
  return out;
}

(async () => {
  loadEnv();
  const target = process.env.GHL_TARGET ?? 'live';
  const apply = flag('apply');
  if (apply && !flag('yes')) { console.error('Refusing to APPLY without --yes.'); process.exit(1); }
  const concurrency = Number(arg('concurrency') ?? 6);
  const ckptName = arg('ckpt') ?? 'stdfields-apply';
  const reportsDir = join(process.cwd(), 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const cachePath = join(reportsDir, 'contacts-cache.json');

  let contacts: Contact[];
  if (!existsSync(cachePath) || flag('refresh')) {
    console.log('Enumerating all contacts (with retry) ...');
    contacts = await enumerateWithRetry();
    writeFileSync(cachePath, JSON.stringify(contacts));
    console.log(`Cached ${contacts.length} contacts -> reports/contacts-cache.json`);
  } else {
    contacts = JSON.parse(readFileSync(cachePath, 'utf8'));
    console.log(`Loaded ${contacts.length} contacts from cache (use --refresh to re-fetch)`);
  }

  if (flag('cache-only')) { console.log('cache-only: done.'); return; }

  const { mappings } = await mappingStore.load();
  const [contact, business] = await Promise.all([getContactFieldCatalog(), getBusinessFieldCatalog()]);
  const checkpoint = new FileReconcileCheckpoint(join(reportsDir, `checkpoint-${ckptName}.jsonl`));
  const done = await checkpoint.loadDone();
  const withBiz = new Set(contacts.filter((c) => c.businessId).map((c) => c.businessId!));
  console.log(`${apply ? 'APPLY' : 'DRY-RUN'} target=${target} | ${withBiz.size} companies w/ contacts | ${done.size} already done | concurrency ${concurrency}`);

  // Stream drift INCREMENTALLY (append per company) so a timeout-killed chained pass still
  // leaves a complete audit trail. One file per ckpt, accumulated across passes.
  const streamPath = join(reportsDir, `drift-stream-${ckptName}.jsonl`);
  const { appendFileSync } = await import('node:fs');
  let lastLog = Date.now();
  const report = await reconcileAll(mappings, { business, contact }, {
    apply, concurrency, checkpoint, contacts,
    onCompany: (res) => {
      const lines: string[] = [];
      for (const r of res.results) for (const d of r.drift)
        lines.push(JSON.stringify({ companyId: res.companyId, contactId: r.contactId, field: d.field, from: d.from, to: d.to }));
      if (lines.length) appendFileSync(streamPath, lines.join('\n') + '\n');
    },
    onProgress: (d, t) => { if (Date.now() - lastLog > 2500 || d === t) { console.log(`  progress ${d}/${t}`); lastLog = Date.now(); } },
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const summary = await writeReconcileReport(report, {
    jsonPath: join(reportsDir, `report-${ckptName}-${stamp}.json`),
    driftPath: join(reportsDir, `drift-${ckptName}-${stamp}.jsonl`),
  });
  console.log('\n' + summary);
})().catch((e) => { console.error('APPLY FAILED:', e?.message ?? e); process.exit(2); });
