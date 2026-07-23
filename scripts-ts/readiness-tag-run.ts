// scripts-ts/readiness-tag-run.ts — readiness-tagger backfill / nightly reconcile over contacts.
//
//   npx vite-node scripts-ts/readiness-tag-run.ts                     # DRY-RUN, all Team/EIR contacts
//   npx vite-node scripts-ts/readiness-tag-run.ts --limit 5           # DRY-RUN, first 5 in scope
//   npx vite-node scripts-ts/readiness-tag-run.ts --only <id>,<id>    # specific contacts
//   npx vite-node scripts-ts/readiness-tag-run.ts --apply --yes       # APPLY (writes to GHL!) — needs --yes
//   npx vite-node scripts-ts/readiness-tag-run.ts --rederive --apply --yes  # re-derive stops, NO LLM calls
//
// Flags: --apply (default dry-run) --yes (confirm writes) --limit N --concurrency N (default 2)
//        --only id,id --resume (checkpoint) --rederive (recompute stops from existing service_areas)
//        --status a,b (override the contact.status filter's values; default from config, or add
//                      "Approved,Published" for --rederive)
//        --all-status (drop the contact.status filter — re-tag regardless of status; other filters stay)
//        --min-confidence 0 (default 0 — readiness writes every row; Low/verify rows flagged for review)
// Gate: the enricher's config FILTERS (from enricher_configs, default status ∈ {Approved} AND
//        website_team_tags ∋ {Team,EIR}) decide the worklist. --status/--all-status adjust the status
//        filter; --only <ids> bypasses all filters. Same config the real-time pipeline reads.
// GHL write spacing: keep GHL_MAX_RPS ≤ 3 for ≥0.3s spacing (client also backs off on 429).
// Emits reports/readiness-<mode>-<stamp>.{json,csv} — the CSV is the human review artifact.
// Reads .env.local. Needs GHL_* and (for --apply, non-rederive) ANTHROPIC_API_KEY.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContactEnricher } from '../lib/enrichment/types';

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

/** CSV cell: quote and escape. */
function csv(v: unknown): string {
  const s = v == null ? '' : Array.isArray(v) ? v.join('; ') : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

(async () => {
  loadEnvLocal();
  const apply = flag('apply');
  const rederive = flag('rederive');
  if (apply && !flag('yes')) {
    console.error('Refusing to APPLY without --yes. This writes to GHL contact records. Re-run with --apply --yes.');
    process.exit(1);
  }

  // Import AFTER env is loaded.
  const { getContactFieldCatalog } = await import('../lib/ghl/customFields');
  const { enumerateAllContacts } = await import('../lib/ghl/contacts');
  const { enrichContact, readContactField } = await import('../lib/enrichment/contactEngine');
  const { readinessTagger, rederiveProposals } = await import('../lib/enrichment/enrichers/readinessTagger');
  const { resolveEnricherConfig } = await import('../lib/enrichment/configStore');
  const { evaluateGate } = await import('../lib/enrichment/gate');
  const { LINE_STOP_FIELD, LINE_KEYS } = await import('../lib/enrichment/data/readiness');
  const { hasAnthropic } = await import('../lib/ai/anthropic');

  // Gate config (filters + combine), read from enricher_configs with a code-default fallback — the
  // same source the real-time pipeline uses, so the backstop honors UI edits too.
  const config = await resolveEnricherConfig('readiness-tagger', 'contact');

  const concurrency = Number(arg('concurrency') ?? 2);
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);
  const minConfidence = arg('min-confidence') ? Number(arg('min-confidence')) : 0;

  // Build the effective filter set for this run from config + CLI overrides. The status field is
  // the one dimension the CLI flags touch (the credit gate): --status a,b replaces its values,
  // --all-status drops it, --only bypasses all filters. Other filters (e.g. membership) always apply.
  const STATUS_FIELD = 'contact.status';
  const allStatus = flag('all-status');
  let filters = [...config.filters];
  if (allStatus) {
    filters = filters.filter((f) => f.field !== STATUS_FIELD);
  } else {
    // rederive is free (no LLM) so it defaults to a broader status set; tag defaults to config's.
    const statusOverride = arg('status') ?? (rederive ? 'Approved,Published' : undefined);
    if (statusOverride !== undefined) {
      const anyOf = statusOverride.split(',').map((s) => s.trim()).filter(Boolean);
      filters = filters.filter((f) => f.field !== STATUS_FIELD);
      if (anyOf.length) filters.push({ field: STATUS_FIELD, anyOf });
    }
  }
  const effectiveConfig = { ...config, filters };
  const describeFilters = filters.length
    ? filters.map((f) => `${f.field}∈{${f.anyOf.join(',')}}`).join(config.combine === 'OR' ? ' OR ' : ' AND ')
    : '(no filters — every contact)';

  const reportsDir = join(process.cwd(), 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const mode = rederive ? 'rederive' : 'tag';
  const tag = `readiness-${mode}-${apply ? 'apply' : 'dryrun'}-${stamp}`;

  const ckptPath = join(reportsDir, `readiness-checkpoint-${mode}-${apply ? 'apply' : 'dryrun'}.jsonl`);
  const done = new Set<string>();
  if (flag('resume') && existsSync(ckptPath)) {
    for (const line of readFileSync(ckptPath, 'utf8').split('\n')) { const id = line.trim(); if (id) done.add(id); }
  }

  console.log(`Readiness ${apply ? 'APPLY' : 'DRY-RUN'} | mode=${mode} | concurrency=${concurrency} | minConf=${minConfidence}` +
    (limit ? ` | limit=${limit}` : '') + (only ? ` | only=${only.length}` : '') + (done.size ? ` | resume(skip ${done.size})` : ''));
  if (!rederive && !hasAnthropic) {
    console.error('⚠️  ANTHROPIC_API_KEY not set — the tagger cannot classify. Set it in .env.local (or use --rederive).');
    if (apply) process.exit(1);
  }

  const catalog = await getContactFieldCatalog();

  // Build worklist: enumerate all contacts, keep those the effective filter gate lets through
  // (--only bypasses the gate entirely).
  let contacts = await enumerateAllContacts();
  if (only) contacts = contacts.filter((c) => only.includes(c.id));
  const inScope = only
    ? contacts
    : contacts.filter((c) => evaluateGate((k) => readContactField(c, catalog, k), effectiveConfig).run);
  let todo = inScope.filter((c) => !done.has(c.id));
  if (limit) todo = todo.slice(0, limit);
  console.log(`Contacts: ${contacts.length} total, ${inScope.length} in scope [${only ? '--only' : describeFilters}]` +
    `, ${todo.length} to process (${done.size} via checkpoint).`);

  // The enricher used this run: the LLM tagger, or a no-LLM re-derive wrapper.
  const rederiveEnricher: ContactEnricher = {
    name: 'readiness-rederive',
    produces: LINE_KEYS.map((l) => LINE_STOP_FIELD[l]),
    enrich: async (input) => rederiveProposals(input),
  };
  const enrichers: ContactEnricher[] = rederive ? [rederiveEnricher] : [readinessTagger];

  const rows: any[] = [];
  const stats = { processed: 0, changed: 0, writes: 0, verify: 0, error: 0 };
  let lastLog = Date.now();

  await runPool(todo, concurrency, async (c) => {
    try {
      const res = await enrichContact(c.id, enrichers, catalog, { mode: 'overwrite', minConfidence }, { apply });
      const byKey = new Map(res.proposals.map((p) => [p.contactKey, p.value]));
      const name = [c.firstName, c.lastName].filter(Boolean).join(' ');
      const rationale = String(byKey.get('contact.readiness_rationale') ?? '');
      const verify = rationale.startsWith('VERIFY');
      if (verify) stats.verify++;
      if (res.applied.length) { stats.changed++; stats.writes += res.applied.length; }
      rows.push({
        contactId: c.id,
        name,
        membership: readContactField(c, catalog, 'contact.website_team_tags'),
        serviceAreas: byKey.get('contact.service_areas') ?? readContactField(c, catalog, 'contact.service_areas'),
        confidence: byKey.get('contact.readiness_confidence') ?? '',
        verify,
        MRL: byKey.get('contact.mrl_stops') ?? [],
        TRL: byKey.get('contact.trl_stops') ?? [],
        CRL: byKey.get('contact.crl_stops') ?? [],
        IRL: byKey.get('contact.investor_readiness_stops') ?? [],
        rationale,
        applied: res.applied.map((a) => a.contactKey),
        didWrite: res.didWrite,
      });
    } catch (e: any) {
      stats.error++;
      rows.push({ contactId: c.id, name: [c.firstName, c.lastName].filter(Boolean).join(' '), error: e?.message ?? String(e) });
    } finally {
      stats.processed++;
      if (apply) appendFileSync(ckptPath, c.id + '\n');
      if (Date.now() - lastLog > 2000 || stats.processed === todo.length) {
        console.log(`  progress ${stats.processed}/${todo.length} | changed=${stats.changed} verify=${stats.verify} errors=${stats.error}`);
        lastLog = Date.now();
      }
    }
  });

  // JSON report.
  const jsonPath = join(reportsDir, `${tag}.json`);
  writeFileSync(jsonPath, JSON.stringify({ tag, apply, mode, minConfidence, stats, rows }, null, 2));

  // CSV review artifact (comparable to LRL_Readiness_Tagging_Prototype.xlsx).
  const header = ['contactId', 'name', 'membership', 'serviceAreas', 'confidence', 'verify', 'MRL', 'TRL', 'CRL', 'IRL', 'rationale', 'applied'];
  const lines = [header.join(',')];
  for (const r of rows.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    lines.push([
      csv(r.contactId), csv(r.name), csv(r.membership), csv(r.serviceAreas), csv(r.confidence), csv(r.verify),
      csv(r.MRL), csv(r.TRL), csv(r.CRL), csv(r.IRL), csv(r.error ? `ERROR: ${r.error}` : r.rationale), csv(r.applied),
    ].join(','));
  }
  const csvPath = join(reportsDir, `${tag}.csv`);
  writeFileSync(csvPath, lines.join('\n') + '\n');

  console.log(`\n${apply ? 'Applied' : 'Would apply'}: ${stats.writes} field-write(s) across ${stats.changed} contact(s). ` +
    `${stats.verify} flagged VERIFY, ${stats.error} error(s).`);
  console.log(`Review CSV: reports/${tag}.csv`);
  console.log(`Full JSON:  reports/${tag}.json`);
  process.exit(0);
})().catch((e) => { console.error('READINESS RUN FAILED:', e?.stack ?? e); process.exit(2); });
