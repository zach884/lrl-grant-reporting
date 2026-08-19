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
for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
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
      await new Promise((res) => setTimeout(res, 320)); // >=0.3s, the 429 rule
    }
  }

  console.log('\nOUTCOMES:', JSON.stringify(tally, null, 1));
  if (approximate) console.log(`\n⚠️  ${approximate} enrollment(s) dated APPROXIMATELY (inferred from a downstream stage).`);
  if (noCompany.length) {
    console.log(`\n⚠️  ${noCompany.length} skipped — contact has no company (businessId):`);
    for (const l of noCompany.slice(0, 20)) console.log(l);
    if (noCompany.length > 20) console.log(`   …and ${noCompany.length - 20} more`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
