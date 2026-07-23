// scripts-ts/resources-tag-run.ts — run the resource-tagger over GHL Resources (Phase B/F).
//
//   npx vite-node scripts-ts/resources-tag-run.ts --all --limit 8      # DRY-RUN a sample (ignore gate)
//   npx vite-node scripts-ts/resources-tag-run.ts                      # DRY-RUN, gated (resource_status)
//   npx vite-node scripts-ts/resources-tag-run.ts --apply --yes --all  # APPLY (writes GHL!) — needs --yes
//
// Classifies each Resource org into the 29-service taxonomy (Claude) + derives stops, writing the 7
// readiness fields on the GHL custom_objects.resources record (equality-guarded ⇒ idempotent). Gate =
// the enricher config (default resource_status ∈ {Approved}); --all ignores it, --status a,b overrides
// the resource_status filter, --only id,id targets records, --limit N caps. Emits reports/. Reads .env.local.

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
function arg(name: string): string | undefined { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; }
function flag(name: string): boolean { return process.argv.includes(`--${name}`); }
function csv(v: unknown): string { const s = v == null ? '' : Array.isArray(v) ? v.join('; ') : String(v); return `"${s.replace(/"/g, '""')}"`; }

const RES_OBJ = 'custom_objects.resources';
const RES_OBJID = '6a590064ad413a5431fc728e';

async function runPool<T>(items: T[], limit: number, worker: (item: T, i: number) => Promise<void>) {
  let idx = 0;
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: n }, async () => { while (idx < items.length) { const i = idx++; await worker(items[i], i); } }));
}

(async () => {
  loadEnvLocal();
  const apply = flag('apply');
  if (apply && !flag('yes')) { console.error('Refusing to APPLY without --yes (writes to GHL resource records).'); process.exit(1); }

  const { ghl } = await import('../lib/ghl/client');
  const { getCatalog } = await import('../lib/ghl/catalogCache');
  const { enrichRecord } = await import('../lib/enrichment/recordEngine');
  const { resourceTagger } = await import('../lib/enrichment/enrichers/resourceTagger');
  const { resolveEnricherConfig } = await import('../lib/enrichment/configStore');
  const { evaluateGate } = await import('../lib/enrichment/gate');
  const { hasAnthropic } = await import('../lib/ai/anthropic');

  if (!hasAnthropic) { console.error('⚠️  ANTHROPIC_API_KEY not set — the tagger cannot classify.'); process.exit(1); }

  const c = ghl();
  const LOC = process.env.GHL_LOCATION_ID;
  const catalog = await getCatalog(RES_OBJ, { force: true });
  const config = await resolveEnricherConfig('resource-tagger', RES_OBJ);
  const concurrency = Number(arg('concurrency') ?? 2);
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);
  const all = flag('all');

  // Effective gate (mirror the readiness CLI): --all drops the gate; --status overrides resource_status.
  let groups = (config.groups as any[]).map((g) => ({ combine: g.combine, filters: g.filters.map((f: any) => ({ ...f })) }));
  const statusOverride = arg('status');
  if (statusOverride) { const anyOf = statusOverride.split(',').map((s) => s.trim()).filter(Boolean); groups = groups.map((g) => ({ ...g, filters: g.filters.map((f: any) => f.field === `${RES_OBJ}.resource_status` ? { ...f, anyOf } : f) })); }
  const gateCfg = { ...config, groups: all ? [] : groups } as typeof config;

  // Load all resource records.
  const recs: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const d: any = await c.request({ method: 'POST', path: `/objects/${RES_OBJID}/records/search`, autoLocation: false, body: { locationId: LOC, query: '', page, pageLimit: 100, searchAfter: [], sort: [{ field: 'updatedAt', direction: 'desc' }] } });
    const r = d.records ?? d.data ?? []; recs.push(...r); if (r.length < 100) break;
  }
  let scope = recs;
  if (only) scope = scope.filter((r) => only.includes(r.id ?? r._id));
  else scope = scope.filter((r) => evaluateGate((k) => (r.properties ?? {})[k.replace(`${RES_OBJ}.`, '')], gateCfg).run);
  let todo = scope;
  if (limit) todo = todo.slice(0, limit);

  console.log(`Resources ${apply ? 'APPLY' : 'DRY-RUN'} | records ${recs.length}, in scope ${scope.length}${all ? ' [--all: no gate]' : ''}, processing ${todo.length} | concurrency ${concurrency}`);

  const reportsDir = join(process.cwd(), 'reports'); mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tag = `resources-tag-${apply ? 'apply' : 'dryrun'}-${stamp}`;
  const rows: any[] = []; const stats = { processed: 0, changed: 0, writes: 0, verify: 0, error: 0 }; let last = Date.now();

  await runPool(todo, concurrency, async (r) => {
    const id = r.id ?? r._id; const name = (r.properties ?? {}).resources ?? '';
    try {
      const res = await enrichRecord(RES_OBJ, id, [resourceTagger], catalog, { mode: 'overwrite', minConfidence: 0 }, { apply });
      const byKey = new Map(res.proposals.map((p) => [p.fieldKey.replace(`${RES_OBJ}.`, ''), p.value]));
      const rationale = String(byKey.get('readiness_rationale') ?? ''); const verify = rationale.startsWith('VERIFY');
      if (verify) stats.verify++;
      if (res.applied.length) { stats.changed++; stats.writes += res.applied.length; }
      rows.push({ id, name, serviceAreas: byKey.get('service_areas') ?? [], confidence: byKey.get('readiness_confidence') ?? '', verify,
        MRL: byKey.get('mrl_stops') ?? [], TRL: byKey.get('trl_stops') ?? [], CRL: byKey.get('crl_stops') ?? [], IRL: byKey.get('investor_readiness_stops') ?? [], rationale, applied: res.applied.map((a) => a.fieldKey) });
    } catch (e: any) { stats.error++; rows.push({ id, name, error: e?.message ?? String(e) }); }
    finally { stats.processed++; if (Date.now() - last > 2000 || stats.processed === todo.length) { console.log(`  ${stats.processed}/${todo.length} | changed=${stats.changed} verify=${stats.verify} err=${stats.error}`); last = Date.now(); } }
  });

  writeFileSync(join(reportsDir, `${tag}.json`), JSON.stringify({ tag, apply, stats, rows }, null, 2));
  const header = ['id', 'name', 'serviceAreas', 'confidence', 'verify', 'MRL', 'TRL', 'CRL', 'IRL', 'rationale'];
  const lines = [header.join(',')];
  for (const r of rows.sort((a, b) => String(a.name).localeCompare(String(b.name)))) lines.push([csv(r.id), csv(r.name), csv(r.serviceAreas), csv(r.confidence), csv(r.verify), csv(r.MRL), csv(r.TRL), csv(r.CRL), csv(r.IRL), csv(r.error ? `ERROR: ${r.error}` : r.rationale)].join(','));
  writeFileSync(join(reportsDir, `${tag}.csv`), lines.join('\n') + '\n');

  // Console preview
  console.log(`\n${apply ? 'Applied' : 'Would apply'}: ${stats.writes} field-write(s) across ${stats.changed} resource(s). ${stats.verify} VERIFY, ${stats.error} error(s).`);
  for (const r of rows.slice(0, 12)) console.log(`  • ${r.name}: ${r.error ? 'ERROR ' + r.error : `[${(r.serviceAreas || []).join(', ')}] (${r.confidence}${r.verify ? ', VERIFY' : ''})`}`);
  console.log(`\nReview: reports/${tag}.csv`);
  process.exit(0);
})().catch((e) => { console.error('RESOURCES TAG RUN FAILED:', e?.stack ?? e); process.exit(2); });
