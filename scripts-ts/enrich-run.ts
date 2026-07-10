// scripts-ts/enrich-run.ts — batch data enrichment across all companies.
//
//   npx vite-node scripts-ts/enrich-run.ts                      # DRY-RUN, all companies
//   npx vite-node scripts-ts/enrich-run.ts --limit 25           # DRY-RUN, first 25
//   npx vite-node scripts-ts/enrich-run.ts --apply --yes        # APPLY (writes!) — needs --yes
//   npx vite-node scripts-ts/enrich-run.ts --apply --yes --resume
//
// Flags: --apply (default dry-run) --yes (confirm writes) --limit N --concurrency N
//        --resume (skip companies already done this mode) --only id,id --min-confidence 0.7
// Runs the default enrichers (county, geo-zone, NAICS) over each company under an overwrite
// policy. Idempotent: geo/NAICS enrichers skip already-correct values. Reads .env.local.
// Mirrors scripts-ts/reconcile-run.ts.

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBusinessFieldCatalog } from '../lib/ghl/customFields';
import { listAllBusinesses } from '../lib/ghl/businesses';
import { enrichCompany, defaultEnrichers } from '../lib/enrichment';

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
  let idx = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i], i);
    }
  }));
}

(async () => {
  loadEnvLocal();
  const apply = flag('apply');
  const yes = flag('yes');
  if (apply && !yes) {
    console.error('Refusing to APPLY without --yes. This writes to company records. Re-run with --apply --yes.');
    process.exit(1);
  }
  const target = process.env.GHL_TARGET ?? 'live';
  const concurrency = Number(arg('concurrency') ?? 4);
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);
  const minConfidence = arg('min-confidence') ? Number(arg('min-confidence')) : 0.7;

  const reportsDir = join(process.cwd(), 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tag = `${target}-${apply ? 'apply' : 'dryrun'}-${stamp}`;

  // Checkpoint (resume): a jsonl of company ids already processed this mode.
  const ckptPath = join(reportsDir, `enrich-checkpoint-${target}-${apply ? 'apply' : 'dryrun'}.jsonl`);
  const done = new Set<string>();
  if (flag('resume') && existsSync(ckptPath)) {
    for (const line of readFileSync(ckptPath, 'utf8').split('\n')) {
      const id = line.trim();
      if (id) done.add(id);
    }
  }

  console.log(`Enrich ${apply ? 'APPLY' : 'DRY-RUN'} | target=${target} | concurrency=${concurrency} | minConf=${minConfidence}` +
    (limit ? ` | limit=${limit}` : '') + (only ? ` | only=${only.length}` : ''));
  if (!process.env.ANTHROPIC_API_KEY) console.warn('⚠️  ANTHROPIC_API_KEY not set — NAICS enrichment will be skipped.');

  const business = await getBusinessFieldCatalog();
  let companies = await listAllBusinesses();
  if (only) companies = companies.filter((c) => only.includes(c.id));
  if (limit) companies = companies.slice(0, limit);
  const todo = companies.filter((c) => !done.has(c.id));
  console.log(`Companies: ${companies.length} total, ${todo.length} to process (${done.size} skipped via checkpoint)`);

  const rows: any[] = [];
  let processed = 0, changed = 0, writes = 0, lastLog = Date.now();
  await runPool(todo, concurrency, async (co) => {
    try {
      const res = await enrichCompany(co.id, defaultEnrichers, business, { mode: 'overwrite', minConfidence }, { apply });
      if (res.applied.length) {
        changed++;
        writes += res.applied.length;
        rows.push({ companyId: co.id, name: co.name, applied: res.applied, skipped: res.skipped, didWrite: res.didWrite });
      }
    } catch (e: any) {
      rows.push({ companyId: co.id, name: co.name, error: e?.message ?? String(e) });
    } finally {
      processed++;
      appendFileSync(ckptPath, co.id + '\n');
      if (Date.now() - lastLog > 2000 || processed === todo.length) {
        console.log(`  progress ${processed}/${todo.length} | companies changed=${changed} fields=${writes}`);
        lastLog = Date.now();
      }
    }
  });

  const reportPath = join(reportsDir, `enrich-report-${tag}.json`);
  writeFileSync(reportPath, JSON.stringify({ target, apply, minConfidence, processed, changed, writes, rows }, null, 2));
  console.log(`\n${apply ? 'Applied' : 'Would apply'}: ${writes} field(s) across ${changed} company(ies).`);
  console.log(`Report: reports/enrich-report-${tag}.json`);
  process.exit(0);
})().catch((e) => { console.error('ENRICH FAILED:', e?.stack ?? e); process.exit(2); });
