// scripts-ts/opportunity-ingest-run.ts — backfill enrollments + grant status from the pipelines.
//
// Dry-run by default (house rule).
//   npx vite-node scripts-ts/opportunity-ingest-run.ts
//   npx vite-node scripts-ts/opportunity-ingest-run.ts --apply
//
// ⚠️ What a backfill CAN'T recover: an opportunity is only ever in one stage, so the path it took is
// gone. Enrollment is therefore inferred from downstream stages where configured, and those records
// carry the opportunity's creation date, flagged approximate. Forward capture via the webhook is the
// only source of exact acceptance dates — every week it isn't wired is history that can't be fixed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Local dev reads .env.local; in CI (GitHub Actions) the secrets arrive as real env vars and the
// file does not exist — an unguarded readFileSync ENOENTs the whole run before it starts.
try {
  for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env.local (CI) — env is already populated */ }
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';
const APPLY = process.argv.includes('--apply');

const PIPELINES: Array<[string, string]> = [
  ['Ewioq7ycVmNpJ9oCM3JC', 'LOCAL Fellows Bootcamp'],
  ['nRK4xQsQ9V4jmXbmz5YO', 'S&MA Cohort'],
  ['trGMRtrlkvUG1UtMbuMJ', 'Direct Grants'],
];

(async () => {
  const { ghl } = await import('../lib/ghl/client');
  const { listOpportunities, ingestOpportunity } = await import('../lib/activities/sources/opportunityStage');
  const c = ghl();

  console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply to write)\n');
  const tally: Record<string, number> = {};
  const bump = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
  /** field key → how many records would have it written. */
  const fieldHits = new Map<string, number>();
  /** declared key-mismatch aliases that fired (see FIELD_ALIASES). */
  const aliasHits = new Map<string, number>();
  const noCompany: string[] = [];
  let approximate = 0;

  for (const [pid, name] of PIPELINES) {
    const opps = await listOpportunities(pid, c);
    console.log(`${name.padEnd(28)} ${String(opps.length).padStart(4)} opportunit(ies)`);
    for (const o of opps) {
      const r = await ingestOpportunity(o, { client: c, dryRun: !APPLY, backfill: true });
      bump(r.status === 'ingested' ? (r.activity?.outcome ?? 'would-write') : `skip:${r.reason}`);
      if (r.approximateDate) approximate++;
      if (r.reason === 'no-company') noCompany.push(`  ${String(o.name ?? o.id).slice(0, 44)}`);
      // WHICH fields an update would touch, not just how many updates. "would-update: 24" cannot be
      // reviewed; a field histogram can — and this adapter now copies the form's detail fields at two
      // stages, so knowing what it writes is the difference between a review and a rubber stamp.
      for (const f of r.activity?.written ?? []) fieldHits.set(f, (fieldHits.get(f) ?? 0) + 1);
      for (const a of r.aliases ?? []) {
        const k = `${a.from} → ${a.to}`;
        aliasHits.set(k, (aliasHits.get(k) ?? 0) + 1);
      }
      await new Promise((res) => setTimeout(res, 320)); // >=0.3s, the 429 rule
    }
  }

  console.log('\nOUTCOMES:', JSON.stringify(tally, null, 1));
  if (fieldHits.size) {
    console.log('\nfields written, by how many records:');
    for (const [f, n] of Array.from(fieldHits.entries()).sort((a, b) => b[1] - a[1]).slice(0, 25)) {
      console.log(`   ${String(n).padStart(4)}  ${f}`);
    }
    if (fieldHits.size > 25) console.log(`   …and ${fieldHits.size - 25} more field(s)`);
  }
  if (aliasHits.size) {
    console.log('\nALIASES FIRED (fields that do NOT key-match, carried by the declared table):');
    for (const [k, n] of Array.from(aliasHits.entries()).sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)}×  ${k}`);
  }
  if (approximate) console.log(`\n⚠️  ${approximate} enrollment(s) dated APPROXIMATELY (inferred from a downstream stage).`);
  if (noCompany.length) {
    console.log(`\n⚠️  ${noCompany.length} skipped — contact has no company (businessId):`);
    for (const l of noCompany.slice(0, 20)) console.log(l);
    if (noCompany.length > 20) console.log(`   …and ${noCompany.length - 20} more`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
