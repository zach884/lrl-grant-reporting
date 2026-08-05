// scripts-ts/stage-score-run.ts — Client Stage scorer: batch / on-demand runner over COMPANIES.
//
//   npx vite-node scripts-ts/stage-score-run.ts                      # DRY-RUN, all companies with a route
//   npx vite-node scripts-ts/stage-score-run.ts --limit 20           # DRY-RUN, first 20 companies examined
//   npx vite-node scripts-ts/stage-score-run.ts --only <id>,<id>     # specific companies
//   npx vite-node scripts-ts/stage-score-run.ts --apply --yes        # APPLY (creates stage records!) — needs --yes
//   npx vite-node scripts-ts/stage-score-run.ts --initial-only       # ignore prior history (score as initial)
//   npx vite-node scripts-ts/stage-score-run.ts --model claude-haiku-4-5   # cheaper tier (validate first)
//   npx vite-node scripts-ts/stage-score-run.ts --apply --yes --gated --resume   # nightly sweep (see nightly-score.yml)
//
// Flags: --apply (default dry-run) --yes (confirm writes) --limit N (cap companies EXAMINED)
//        --only id,id  --concurrency N (default 2)  --resume (checkpoint)  --initial-only  --model <id>
//        --gated (only (re)score companies whose inputs changed since last score — the nightly cost guard)
//        --no-propagate (skip pushing scores up to company *_current after each write; propagation is on
//                        by default when applying)
// On apply, each write: sets the input fingerprint (enricher_state) + logs to the change_log + propagates
//        scores to the company's *_current fields (business_stage → business) — same as the real-time trigger.
// Routing: business.business_model → tech / service / both (see lib/stage/scoreCompany.routePath).
//        Companies with no recognized business_model are SKIPPED and reported.
// ACCEPTANCE: the dry-run CSV shows the company's PRIOR scores (from a stage record, or — before the
//        backfill — the contact *_current fields written by the legacy workflow) next to the NEW scores,
//        with per-dimension deltas + agreement flags. Compare on already-scored clients before trusting.
// GHL write spacing: keep GHL_MAX_RPS ≤ 3. Reads .env.local; needs GHL_* and ANTHROPIC_API_KEY.
// Emits reports/stage-score-<mode>-<stamp>.{json,csv}.

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
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function runPool<T>(items: T[], limit: number, worker: (item: T, i: number) => Promise<void>) {
  let idx = 0;
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: n }, async () => {
    while (idx < items.length) { const i = idx++; await worker(items[i], i); }
  }));
}
function csv(v: unknown): string {
  const s = v == null ? '' : Array.isArray(v) ? v.join('; ') : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}
/** Per-dimension agreement label between prior and new (validation aid). */
function agree(prior: number | null | undefined, next: number | null | undefined): string {
  if (prior == null || next == null) return '';
  const d = Math.abs(next - prior);
  return d === 0 ? 'exact' : d === 1 ? 'within1' : `off(${next - prior > 0 ? '+' : ''}${next - prior})`;
}

(async () => {
  loadEnvLocal();
  if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';
  const apply = flag('apply');
  if (apply && !flag('yes')) {
    console.error('Refusing to APPLY without --yes. This CREATES stage records in GHL. Re-run with --apply --yes.');
    process.exit(1);
  }

  // Import AFTER env is loaded.
  const { ghl } = await import('../lib/ghl/client');
  const { listAllBusinesses } = await import('../lib/ghl/businesses');
  const { readRecordFields } = await import('../lib/ghl/records');
  const { getCatalog } = await import('../lib/ghl/catalogCache');
  const { routePath, scoreCompany } = await import('../lib/stage/scoreCompany');
  const { labelResolvingAccessor, buildInputBlob, PATH_DIMENSIONS } = await import('../lib/stage/companyInputs');
  const { getCompanyStageContext, getStageAssociationId, STAGE_OBJECT } = await import('../lib/stage/priorAssessment');
  const { createStageRecord, updateStageRecord } = await import('../lib/stage/writeStageRecord');
  const { propagateCurrentScoring } = await import('../lib/stage/propagateScoring');
  const { STAGE_SCORER_NAME } = await import('../lib/stage/trigger');
  const { fingerprint, getEnricherState, setEnricherState } = await import('../lib/enrichment/stateStore');
  const { logChange } = await import('../lib/audit/log');
  const { withRun, newRunId } = await import('../lib/audit/context');
  const { hasAnthropic, SCORING_MODEL } = await import('../lib/ai/anthropic');

  const client = ghl();
  const concurrency = Number(arg('concurrency') ?? 2);
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);
  const initialOnly = flag('initial-only');
  const model = arg('model') ?? SCORING_MODEL;
  // After each write, push the new scores up to the company's *_current fields (business_stage →
  // business), same as the real-time trigger. On by default when applying; --no-propagate to skip.
  const doPropagate = apply && !flag('no-propagate');
  // --gated: only (re)score a company when its scoring inputs changed since the last score (same
  // input-fingerprint gate as the real-time trigger). The nightly sweep runs gated so a clean night
  // spends ~no Claude credits; manual runs stay ungated (re-score everything) unless --gated is set.
  const gated = flag('gated');

  console.log(`Stage scorer ${apply ? 'APPLY' : 'DRY-RUN'} | target=${process.env.GHL_TARGET} | model=${model} | concurrency=${concurrency}` +
    (limit ? ` | limit=${limit}` : '') + (only ? ` | only=${only.length}` : '') + (initialOnly ? ' | initial-only' : ''));
  if (!hasAnthropic) {
    console.error('⚠️  ANTHROPIC_API_KEY not set — the scorer cannot run. Set it in .env.local.');
    process.exit(1);
  }

  // Catalogs: stage object (for option labels on write) + business (to render input option keys as
  // human labels for the scorer) + the company↔stage association id.
  const stageCatalog = await getCatalog(STAGE_OBJECT, { client });
  const businessCatalog = await getCatalog('business', { client });
  const assocId = await getStageAssociationId(client);
  if (apply && !assocId) { console.error('company_business_stage association not found — cannot associate records.'); process.exit(1); }

  // Worklist: companies (id + name). --limit caps how many are EXAMINED (routing needs a per-record read).
  let companies = await listAllBusinesses(client);
  if (only) companies = companies.filter((c) => only.includes(c.id));
  if (limit) companies = companies.slice(0, limit);

  const reportsDir = join(process.cwd(), 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tag = `stage-score-${apply ? 'apply' : 'dryrun'}-${stamp}`;
  const ckptPath = join(reportsDir, `stage-score-checkpoint-${apply ? 'apply' : 'dryrun'}.txt`);
  const done = new Set<string>();
  if (flag('resume') && existsSync(ckptPath)) {
    for (const l of readFileSync(ckptPath, 'utf8').split('\n')) { const id = l.trim(); if (id) done.add(id); }
  }
  const todo = companies.filter((c) => !done.has(c.id));
  console.log(`Companies: ${companies.length} examined${limit ? ' (capped)' : ''}, ${todo.length} to process (${done.size} via checkpoint).`);

  const rows: any[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const stats = { processed: 0, inScope: 0, scored: 0, skippedNoRoute: 0, skippedNoInputs: 0, skippedUnchanged: 0, created: 0, updated: 0, error: 0 };
  let lastLog = Date.now();

  // One run id + trigger for the whole sweep, so every scorer/propagation change this batch logs is
  // correlated in the change log (the same withRun discipline the real-time webhook uses).
  await withRun({ runId: newRunId(), trigger: 'batch:stage-score-run' }, () =>
   runPool(todo, concurrency, async (co) => {
    const name = co.name || co.id;
    try {
      const rf = await readRecordFields('business', co.id, client);
      const field = labelResolvingAccessor(rf.get, businessCatalog);
      const path = routePath(field('business.business_model'));
      if (!path) {
        stats.skippedNoRoute++;
        rows.push({ companyId: co.id, name, action: 'skip(no-route)', businessModel: rf.get('business.business_model') ?? '' });
        return;
      }
      stats.inScope++;
      // One fetch: the prior assessment (excluding any record already dated today) + today's record id.
      const ctx = await getCompanyStageContext(co.id, today, { client, assocId });

      // Fingerprint gate (--gated): skip — with NO Claude call — a company already scored whose inputs
      // haven't changed since. Mirrors the real-time trigger, so a company scored in real time is not
      // re-scored by the nightly sweep. Only gates companies that already have a score record.
      const blob = buildInputBlob(field, PATH_DIMENSIONS[path]);
      const inputHash = fingerprint(blob);
      if (gated && blob.trim()) {
        const hasRecord = Boolean(ctx.todayRecordId) || ctx.prior?.source === 'record';
        if (hasRecord) {
          const state = await getEnricherState(co.id);
          if (state?.scoreInputHash === inputHash) {
            stats.skippedUnchanged++;
            rows.push({ companyId: co.id, name, path, action: 'skip(unchanged)' });
            return;
          }
        }
      }

      const prior = initialOnly ? null : ctx.prior;
      const score = await scoreCompany({ field, path, prior, model });
      if (!score) {
        // Distinguish "nothing to score from" (inputs not populated on the company — often the up-sync
        // hasn't carried the intake answers up yet) from a genuine scoring failure.
        const hadInputs = blob.trim().length > 0;
        if (hadInputs) { stats.error++; rows.push({ companyId: co.id, name, path, action: 'error(no-score)' }); }
        else { stats.skippedNoInputs++; rows.push({ companyId: co.id, name, path, action: 'skip(no-inputs)' }); }
        return;
      }
      stats.scored++;

      // Label correctness: when scoring FRESH (--initial-only, no prior fed — the most reliable way to
      // re-score the base under a rubric change) for a company that already has history, the new record
      // is still a RE-SCORE. Mark it so snapshot_kind reads "Rescore", not "Initial". Genuinely new
      // companies (no prior, no today record) stay "Initial".
      if (score.rescore === false && (ctx.prior || ctx.todayRecordId)) score.rescore = true;

      // Upsert semantics: overwrite today's record if one exists (same-day correction), else append a
      // new one. In dry-run, just report which it would be.
      const willOverwrite = Boolean(ctx.todayRecordId);
      let recordId = ctx.todayRecordId ?? '';
      if (apply) {
        const propsInput = { score, name, rescoreDate: today };
        const action: 'create' | 'update' = ctx.todayRecordId ? 'update' : 'create';
        if (ctx.todayRecordId) {
          await updateStageRecord(ctx.todayRecordId, propsInput, { catalog: stageCatalog, client });
          stats.updated++;
        } else {
          const res = await createStageRecord(propsInput, { catalog: stageCatalog, assocId: assocId!, companyId: co.id, client });
          recordId = res.recordId;
          stats.created++;
        }
        // Remember the inputs we just scored, so a gated re-run (nightly / real-time) skips this
        // company until an input actually changes. Best-effort — never fail the score on a state error.
        try { await setEnricherState(co.id, { scoreInputHash: inputHash }); } catch { /* best-effort */ }
        // Audit trail: log the scorer write (scores + combined rationale), same shape as the real-time
        // trigger — closes the gap where batch-created records never reached the change log.
        try {
          const logFields: Array<{ field: string; to: unknown }> = [];
          if (score.trl != null) logFields.push({ field: 'trl', to: score.trl });
          if (score.mrl != null) logFields.push({ field: 'mrl', to: score.mrl });
          if (score.crl != null) logFields.push({ field: 'crl', to: score.crl });
          if (score.churchillStage != null) logFields.push({ field: 'churchill_score', to: score.churchillStage });
          if (score.churchillSubstage) logFields.push({ field: 'churchill_substage', to: score.churchillSubstage });
          await logChange({
            objectType: STAGE_OBJECT, recordId, recordLabel: name, actorKind: 'scorer', actorName: STAGE_SCORER_NAME,
            action, changes: logFields, method: 'ai',
            rationale: [score.techRationale, score.serviceRationale].filter(Boolean).join('\n\n---\n\n'),
            applied: true,
          });
        } catch { /* best-effort */ }
        // Propagate the scores up to the company's *_current fields. Non-fatal: keep the score even if
        // propagation fails (it's best-effort and the nightly reconcile will reconcile contacts anyway).
        if (doPropagate && recordId) {
          try { await propagateCurrentScoring(recordId, { apply: true, client }); }
          catch (e: any) { console.warn(`  ⚠️  propagate failed for ${co.id}: ${e?.message ?? e}`); }
        }
      }

      rows.push({
        companyId: co.id, name, path,
        action: apply ? (willOverwrite ? 'updated' : 'created') : (willOverwrite ? 'would-update' : 'would-create'),
        // Compare against the company's EXISTING assessment (ctx.prior) for the report, even under
        // --initial-only where no prior was fed to the scorer — so before→after deltas always show.
        rescore: score.rescore, priorSource: ctx.prior?.source ?? '',
        prior_trl: ctx.prior?.trl ?? '', new_trl: score.trl ?? '', a_trl: agree(ctx.prior?.trl, score.trl),
        prior_mrl: ctx.prior?.mrl ?? '', new_mrl: score.mrl ?? '', a_mrl: agree(ctx.prior?.mrl, score.mrl),
        prior_crl: ctx.prior?.crl ?? '', new_crl: score.crl ?? '', a_crl: agree(ctx.prior?.crl, score.crl),
        prior_churchill: ctx.prior?.churchillStage ?? '', new_churchill: score.churchillStage ?? '', a_churchill: agree(ctx.prior?.churchillStage, score.churchillStage),
        prior_substage: ctx.prior?.churchillSubstage ?? '', new_substage: score.churchillSubstage ?? '',
        recordId,
        rationale: [score.techRationale, score.serviceRationale].filter(Boolean).join(' | '),
      });
    } catch (e: any) {
      stats.error++;
      rows.push({ companyId: co.id, name, action: 'error', error: e?.message ?? String(e) });
    } finally {
      stats.processed++;
      if (apply) appendFileSync(ckptPath, co.id + '\n');
      if (Date.now() - lastLog > 2000 || stats.processed === todo.length) {
        console.log(`  progress ${stats.processed}/${todo.length} | inScope=${stats.inScope} scored=${stats.scored} unchanged=${stats.skippedUnchanged} noRoute=${stats.skippedNoRoute} noInputs=${stats.skippedNoInputs} errors=${stats.error}`);
        lastLog = Date.now();
      }
    }
   }));

  // JSON report.
  writeFileSync(join(reportsDir, `${tag}.json`), JSON.stringify({ tag, apply, model, stats, rows }, null, 2));

  // CSV review / acceptance artifact.
  const header = ['companyId', 'name', 'path', 'action', 'rescore', 'priorSource',
    'prior_trl', 'new_trl', 'a_trl', 'prior_mrl', 'new_mrl', 'a_mrl', 'prior_crl', 'new_crl', 'a_crl',
    'prior_churchill', 'new_churchill', 'a_churchill', 'prior_substage', 'new_substage', 'recordId', 'rationale'];
  const lines = [header.join(',')];
  for (const r of rows.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    lines.push(header.map((h) => csv(h === 'rationale' && r.error ? `ERROR: ${r.error}` : r[h])).join(','));
  }
  writeFileSync(join(reportsDir, `${tag}.csv`), lines.join('\n') + '\n');

  // Acceptance summary: agreement across rows that had a prior to compare against.
  const withPrior = rows.filter((r) => r.priorSource);
  const summarize = (key: string) => {
    const vals = withPrior.map((r) => r[key]).filter(Boolean);
    const exact = vals.filter((v) => v === 'exact').length;
    const within1 = vals.filter((v) => v === 'within1').length;
    return vals.length ? `${key.slice(2).toUpperCase()}: ${exact}/${vals.length} exact, ${exact + within1}/${vals.length} within-1` : '';
  };

  console.log(`\n${apply ? `Created ${stats.created}, updated ${stats.updated}` : `Would create/update ${stats.scored}`} stage record(s). ` +
    `inScope=${stats.inScope}${gated ? ` unchanged=${stats.skippedUnchanged}` : ''} noRoute=${stats.skippedNoRoute} noInputs=${stats.skippedNoInputs} errors=${stats.error}.`);
  if (withPrior.length) {
    console.log(`Acceptance vs prior (${withPrior.length} companies with a prior assessment):`);
    for (const k of ['a_trl', 'a_mrl', 'a_crl', 'a_churchill']) { const s = summarize(k); if (s) console.log('  ' + s); }
  }
  console.log(`Review CSV: reports/${tag}.csv`);
  console.log(`Full JSON:  reports/${tag}.json`);
  process.exit(0);
})().catch((e) => { console.error('STAGE SCORE RUN FAILED:', e?.stack ?? e); process.exit(2); });
