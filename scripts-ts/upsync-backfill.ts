// scripts-ts/upsync-backfill.ts — one-time UP-sync backfill (contact → company).
//
// The real-time up-sync (/api/sync/up → applyContactChange) only fires when a contact CHANGES, so
// companies whose contacts answered the intake BEFORE the mapping existed never got those answers
// pushed up. This replays the contact→company push across ALL existing contacts to populate the
// company records (esp. business_model + the scorer's inputs), making them scorable. UP-only by design
// (the company→contacts down-mirror is the separate `npm run reconcile`); scoring reads the company.
//
//   npx vite-node scripts-ts/upsync-backfill.ts                 # DRY-RUN, all contacts
//   npx vite-node scripts-ts/upsync-backfill.ts --limit 100     # DRY-RUN, first 100 contacts
//   npx vite-node scripts-ts/upsync-backfill.ts --apply --yes   # APPLY (writes to companies!)
//
// Flags: --apply (default dry-run) --yes (confirm) --limit N --concurrency N (default 3)
//        --resume (checkpoint) --only id,id (contact ids). Reads .env.local; GHL_TARGET default live.
// Equality-guarded + idempotent (re-running writes nothing new). Emits reports/upsync-backfill-*.{json,csv}.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
function csv(v: unknown): string { const s = v == null ? '' : Array.isArray(v) ? v.join('; ') : String(v); return `"${s.replace(/"/g, '""')}"`; }

(async () => {
  loadEnvLocal();
  if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';
  const apply = flag('apply');
  if (apply && !flag('yes')) { console.error('Refusing to APPLY without --yes. This writes to company records. Re-run with --apply --yes.'); process.exit(1); }

  const { ghl } = await import('../lib/ghl/client');
  const { enumerateAllContacts } = await import('../lib/ghl/contacts');
  const { loadPushConnection, CONTACT_TO_COMPANY_SLUG } = await import('../lib/sync/orchestrate');
  const { syncConnection } = await import('../lib/sync/apply');
  const { runPool } = await import('../lib/sync/reconcile');

  const client = ghl();
  const concurrency = Number(arg('concurrency') ?? 3);
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);

  const c2c = await loadPushConnection(CONTACT_TO_COMPANY_SLUG);
  if (!c2c) { console.error(`${CONTACT_TO_COMPANY_SLUG} connection is not configured.`); process.exit(1); }

  console.log(`UP-sync backfill ${apply ? 'APPLY' : 'DRY-RUN'} | target=${process.env.GHL_TARGET} | concurrency=${concurrency}` +
    (limit ? ` | limit=${limit}` : '') + (only ? ` | only=${only.length}` : ''));

  // Worklist: all contacts linked to a company (only those can push up).
  let contacts = (await enumerateAllContacts(client)).filter((c) => c.businessId);
  if (only) contacts = contacts.filter((c) => only.includes(c.id));
  if (limit) contacts = contacts.slice(0, limit);

  const reportsDir = join(process.cwd(), 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tag = `upsync-backfill-${apply ? 'apply' : 'dryrun'}-${stamp}`;
  const ckptPath = join(reportsDir, `upsync-backfill-checkpoint-${apply ? 'apply' : 'dryrun'}.txt`);
  const done = new Set<string>();
  if (flag('resume') && existsSync(ckptPath)) for (const l of readFileSync(ckptPath, 'utf8').split('\n')) { const id = l.trim(); if (id) done.add(id); }
  const todo = contacts.filter((c) => !done.has(c.id));
  console.log(`Contacts linked to a company: ${contacts.length}${limit ? ' (capped)' : ''}, ${todo.length} to process (${done.size} via checkpoint).`);

  const rows: any[] = [];
  const companiesTouched = new Set<string>();
  const companiesNewlyRoutable = new Set<string>(); // would get business_model written
  const stats = { processed: 0, contactsWithWrites: 0, fieldWrites: 0, errors: 0 };
  let lastLog = Date.now();

  await runPool(todo, concurrency, async (c: { id: string; businessId?: string }) => {
    try {
      const res = await syncConnection(c2c, c.id, { apply }, undefined, client);
      const fwd = res.forward?.[0];
      const companyId = fwd?.targetId;
      const fields: string[] = apply ? (fwd?.written ?? []) : (fwd?.changes?.map((x: any) => x.fieldKey) ?? []);
      if (companyId && fields.length) {
        companiesTouched.add(companyId);
        if (fields.some((f) => f.endsWith('business_model'))) companiesNewlyRoutable.add(companyId);
        stats.contactsWithWrites++;
        stats.fieldWrites += fields.length;
        rows.push({ contactId: c.id, companyId, count: fields.length, fields });
      }
    } catch (e: any) {
      stats.errors++;
      rows.push({ contactId: c.id, companyId: c.businessId ?? '', error: e?.message ?? String(e) });
    } finally {
      stats.processed++;
      if (apply) appendFileSync(ckptPath, c.id + '\n');
      if (Date.now() - lastLog > 3000 || stats.processed === todo.length) {
        console.log(`  progress ${stats.processed}/${todo.length} | contactsWithWrites=${stats.contactsWithWrites} companies=${companiesTouched.size} newlyRoutable=${companiesNewlyRoutable.size} errors=${stats.errors}`);
        lastLog = Date.now();
      }
    }
  });

  writeFileSync(join(reportsDir, `${tag}.json`), JSON.stringify({ tag, apply, stats, companiesTouched: companiesTouched.size, companiesNewlyRoutable: companiesNewlyRoutable.size, rows }, null, 2));
  const lines = ['contactId,companyId,fieldCount,fields'];
  for (const r of rows) lines.push([csv(r.contactId), csv(r.companyId), csv(r.error ? `ERROR: ${r.error}` : r.count), csv(r.error ? '' : r.fields)].join(','));
  writeFileSync(join(reportsDir, `${tag}.csv`), lines.join('\n') + '\n');

  console.log(`\n${apply ? 'Wrote' : 'Would write'} ${stats.fieldWrites} field(s) to ${companiesTouched.size} compan(ies) from ${stats.contactsWithWrites} contact(s).`);
  console.log(`Companies that ${apply ? 'gained' : 'would gain'} business_model (become scorable): ${companiesNewlyRoutable.size}. Errors: ${stats.errors}.`);
  console.log(`Review CSV: reports/${tag}.csv`);
  process.exit(0);
})().catch((e) => { console.error('UPSYNC BACKFILL FAILED:', e?.stack ?? e); process.exit(2); });
