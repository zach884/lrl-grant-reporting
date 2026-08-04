// scripts-ts/wix-sync-run.ts — backfill/reconcile GHL contacts -> Wix CMS collections.
//
//   npx vite-node scripts-ts/wix-sync-run.ts                 # DRY-RUN, all enabled contact sets
//   npx vite-node scripts-ts/wix-sync-run.ts --limit 5       # DRY-RUN, first 5 contacts
//   npx vite-node scripts-ts/wix-sync-run.ts --set <id>      # only this mapping set
//   npx vite-node scripts-ts/wix-sync-run.ts --apply --yes --resume
//
// Flags: --apply (default dry-run) --yes (confirm writes) --set <id> --limit N
//        --concurrency N --resume (checkpoint) --only contactId,contactId
// Reads .env.local automatically. Needs Wix creds (WIX_* ) + POSTGRES_URL/DATABASE_URL.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

async function runPool<T>(items: T[], limit: number, worker: (item: T, i: number) => Promise<void>) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

(async () => {
  loadEnvLocal();
  const apply = flag('apply');
  if (apply && !flag('yes')) {
    console.error('Refusing to APPLY without --yes. This writes to Wix. Re-run with --apply --yes.');
    process.exit(1);
  }
  // Import AFTER env is loaded (lib/db reads POSTGRES_URL at module load).
  const { getWixStore } = await import('../lib/mapping/wixStore');
  const { getContactFieldCatalog } = await import('../lib/ghl/customFields');
  const { enumerateAllContacts } = await import('../lib/ghl/contacts');
  const { getWixCollectionSchema } = await import('../lib/wix/catalogCache');
  const { syncContactToWix } = await import('../lib/wix-sync');
  const { withRun, newRunId } = await import('../lib/audit/context');

  const concurrency = Number(arg('concurrency') ?? 5);
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);
  const setId = arg('set');

  const store = getWixStore();
  const sets = setId ? [await store.getSet(setId)].filter(Boolean) : await store.setsForSource('contact');
  if (!sets.length) { console.error('No enabled contact->Wix mapping sets found.'); process.exit(1); }
  const validSets = sets.filter((s): s is NonNullable<typeof s> => !!s);

  const reportsDir = join(process.cwd(), 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tag = `wix-${apply ? 'apply' : 'dryrun'}-${stamp}`;

  const ckptPath = join(reportsDir, `wix-checkpoint-${setId ?? 'all'}-${apply ? 'apply' : 'dryrun'}.jsonl`);
  const done = new Set<string>();
  if (flag('resume') && existsSync(ckptPath)) {
    for (const line of readFileSync(ckptPath, 'utf8').split('\n')) { const id = line.trim(); if (id) done.add(id); }
  }

  console.log(`Wix sync ${apply ? 'APPLY' : 'DRY-RUN'} | sets=${validSets.length} | concurrency=${concurrency}` +
    (limit ? ` | limit=${limit}` : '') + (only ? ` | only=${only.length}` : '') + (done.size ? ` | resume(skip ${done.size})` : ''));

  const catalog = await getContactFieldCatalog();
  const schemas = new Map<string, Awaited<ReturnType<typeof getWixCollectionSchema>>>();
  for (const s of validSets) if (!schemas.has(s.wixCollectionId)) schemas.set(s.wixCollectionId, await getWixCollectionSchema(s.wixCollectionId));

  // Build the contact worklist.
  let contactIds: string[];
  if (only) contactIds = only;
  else {
    const all = await enumerateAllContacts();
    contactIds = all.map((c) => c.id);
  }
  contactIds = contactIds.filter((id) => !done.has(id));
  if (limit) contactIds = contactIds.slice(0, limit);
  console.log(`Contacts to process: ${contactIds.length}`);

  const stats = { insert: 0, patch: 0, noop: 0, skip: 0, hide: 0, error: 0, fields: 0 };
  const driftPath = join(reportsDir, `${tag}.jsonl`);
  let lastLog = Date.now();
  let processed = 0;

  // Correlate every Wix write this batch logs under one run id + trigger (the change-log sink reads
  // the run context), mirroring the real-time webhook and the stage-score batch.
  await withRun({ runId: newRunId(), trigger: 'batch:wix-sync-run' }, () =>
   runPool(contactIds, concurrency, async (contactId) => {
    let ok = true;
    for (const set of validSets) {
      try {
        const schema = schemas.get(set.wixCollectionId)!;
        const r = await syncContactToWix(contactId, set, catalog, schema, { apply });
        stats[r.action] = (stats[r.action] ?? 0) + 1;
        stats.fields += r.written.length;
        appendFileSync(driftPath, JSON.stringify({ contactId, set: set.name, action: r.action, written: r.written, skipped: r.skipped }) + '\n');
      } catch (e: any) {
        ok = false;
        stats.error++;
        appendFileSync(driftPath, JSON.stringify({ contactId, set: set.name, error: e?.message ?? String(e) }) + '\n');
      }
    }
    if (ok && apply) appendFileSync(ckptPath, contactId + '\n');
    processed++;
    if (Date.now() - lastLog > 2000 || processed === contactIds.length) {
      console.log(`  progress ${processed}/${contactIds.length}`);
      lastLog = Date.now();
    }
   }));

  const report = { tag, apply, sets: validSets.map((s) => ({ id: s.id, name: s.name, collection: s.wixCollectionId })), stats, contacts: contactIds.length };
  writeFileSync(join(reportsDir, `report-${tag}.json`), JSON.stringify(report, null, 2));
  console.log(`\n${apply ? 'APPLIED' : 'DRY-RUN'}: ` +
    `insert=${stats.insert} patch=${stats.patch} noop=${stats.noop} skip=${stats.skip} error=${stats.error} fieldsWritten=${stats.fields}`);
  console.log(`Full report: reports/report-${tag}.json`);
})().catch((e) => { console.error('WIX SYNC FAILED:', e?.stack ?? e); process.exit(2); });
