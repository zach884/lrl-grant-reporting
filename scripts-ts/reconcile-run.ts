// scripts-ts/reconcile-run.ts — run the DOWN-sync reconcile against a target.
//
//   npx vite-node scripts-ts/reconcile-run.ts                     # DRY-RUN, live, all companies
//   npx vite-node scripts-ts/reconcile-run.ts --limit 25          # DRY-RUN, first 25 companies
//   npx vite-node scripts-ts/reconcile-run.ts --apply             # APPLY (writes!) — needs --yes
//   npx vite-node scripts-ts/reconcile-run.ts --apply --yes --resume
//
// Flags: --apply (default dry-run) --yes (confirm writes) --limit N --concurrency N
//        --resume (use checkpoint file, skip done companies) --only id,id
// Target via GHL_TARGET=live|sandbox (default live). Reads .env.local automatically.

import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getBusinessFieldCatalog, getContactFieldCatalog } from '../lib/ghl/customFields';
import { mappingStore } from '../lib/mapping';
import { reconcileAll, writeReconcileReport, FileReconcileCheckpoint } from '../lib/sync/reconcile';

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

(async () => {
  loadEnvLocal();
  const apply = flag('apply');
  const yes = flag('yes');
  if (apply && !yes) {
    console.error('Refusing to APPLY without --yes. This writes to contacts. Re-run with --apply --yes.');
    process.exit(1);
  }
  const target = process.env.GHL_TARGET ?? 'live';
  const concurrency = Number(arg('concurrency') ?? 5);
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);

  const reportsDir = join(process.cwd(), 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tag = `${target}-${apply ? 'apply' : 'dryrun'}-${stamp}`;

  console.log(`Reconcile ${apply ? 'APPLY' : 'DRY-RUN'} | target=${target} | concurrency=${concurrency}` +
    (limit ? ` | limit=${limit}` : '') + (only ? ` | only=${only.length}` : ''));

  const { mappings } = await mappingStore.load();
  const [contact, business] = await Promise.all([getContactFieldCatalog(), getBusinessFieldCatalog()]);
  console.log(`Loaded ${mappings.length} mappings; catalogs contact=${Object.keys(contact.byKey).length} business=${Object.keys(business.byKey).length}`);

  const checkpoint = flag('resume')
    ? new FileReconcileCheckpoint(join(reportsDir, `checkpoint-${target}-${apply ? 'apply' : 'dryrun'}.jsonl`))
    : undefined;

  let lastLog = Date.now();
  const report = await reconcileAll(mappings, { business, contact }, {
    apply,
    concurrency,
    limit,
    onlyCompanyIds: only,
    checkpoint,
    onProgress: (done, total) => {
      if (Date.now() - lastLog > 2000 || done === total) {
        console.log(`  progress ${done}/${total} companies`);
        lastLog = Date.now();
      }
    },
  });

  const summary = await writeReconcileReport(report, {
    jsonPath: join(reportsDir, `report-${tag}.json`),
    driftPath: join(reportsDir, `drift-${tag}.jsonl`),
  });
  console.log('\n' + summary);
  console.log(`\nFull report: reports/report-${tag}.json`);
})().catch((e) => { console.error('RECONCILE FAILED:', e?.stack ?? e); process.exit(2); });
