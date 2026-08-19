// scripts-ts/seed-opportunity-routes.ts — the pipeline-stage rules, per Zach 2026-08-19.
//
// Three pipelines matter: LOCAL Fellows Bootcamp, S&MA Cohort, Direct Grants. (New Clients is not
// useful; Co-Working and Fundraising are not client programs.)
//
//   ENROLLMENT — "which programs was this company in, when", the join the report engine needs:
//     LOCAL  ← "Selected for Bootcamp"    …plus the downstream stages, see below
//     SAMA   ← "Closed Won"
//
//   Why downstream stages for LOCAL: an opportunity is only ever in ONE stage, and measured live,
//   ZERO of 97 LOCAL opportunities still sit in "Selected for Bootcamp" — the ~52 selected have all
//   moved on. Those later stages each IMPLY the company was selected, so they are routed too and
//   marked `impliesAcceptance`, which makes the backfill stamp the opportunity's creation date and
//   label the record approximate. All of them share one source key per opportunity, so a fellow who
//   passed through four of them still gets exactly ONE enrollment record.
//
//   GRANT LIFECYCLE — the Direct Grants pipeline knows what the grant form cannot: that the grant
//   was actually executed and that receipts came in. The OPPORTUNITY IS THE GRANT, so these stages
//   write `grant_status` onto the SAME activity the form fills in — one record, not two.
//
//   npx vite-node scripts-ts/seed-opportunity-routes.ts            # dry run
//   npx vite-node scripts-ts/seed-opportunity-routes.ts --apply

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';
const APPLY = process.argv.includes('--apply');

interface Seed {
  stageId: string;
  label: string;
  activityType: string;
  program?: string[];
  defaults?: Record<string, unknown>;
}

const SEEDS: Seed[] = [
  // ---- LOCAL Fellows Bootcamp — enrollment ----
  { stageId: 'ef82e391-afcf-4ae6-b310-35d19d76cb3f', label: 'LOCAL · Selected for Bootcamp', activityType: 'program_acceptance', program: ['local'] },
  { stageId: 'b711e457-ad8e-465d-ad58-47649670dbf4', label: 'LOCAL · Milestones Identified', activityType: 'program_acceptance', program: ['local'], defaults: { impliesAcceptance: true } },
  { stageId: '654dda8c-5371-43eb-b890-dbf3440a8e07', label: 'LOCAL · Milestones Completed', activityType: 'program_acceptance', program: ['local'], defaults: { impliesAcceptance: true } },
  { stageId: 'df4b9bcd-0520-486f-8e6a-c05061c0df28', label: 'LOCAL · Received Milestone Grant', activityType: 'program_acceptance', program: ['local'], defaults: { impliesAcceptance: true } },
  { stageId: '1cb827ed-4669-41a0-919b-d97c4d9830f4', label: 'LOCAL · Bootcamp Completed', activityType: 'program_acceptance', program: ['local'], defaults: { impliesAcceptance: true } },
  { stageId: '182c23ea-be78-4b0c-ad90-a308c22ac989', label: 'LOCAL · Loan Closed', activityType: 'program_acceptance', program: ['local'], defaults: { impliesAcceptance: true } },
  { stageId: '94cda531-f390-49af-ae1d-9798af51d2f3', label: 'LOCAL · Loan Applied For', activityType: 'program_acceptance', program: ['local'], defaults: { impliesAcceptance: true } },

  // ---- S&MA Cohort — enrollment (Closed Won = they accepted; Acceptance Sent is only an offer) ----
  { stageId: '86007183-57f3-4c05-8d63-53cc01cf7969', label: 'SAMA · Closed Won', activityType: 'program_acceptance', program: ['sama'] },

  // ---- Direct Grants — the grant's lifecycle, onto the activity the form fills in ----
  { stageId: '3bf7ecee-342b-48ab-a874-f300223a45a0', label: 'Direct Grant · Application Complete', activityType: 'grant', defaults: { grant_status: 'Application Complete' } },
  { stageId: '0dfd181d-1270-4fb2-81e9-99606b8fa216', label: 'Direct Grant · Agreement Executed', activityType: 'grant', defaults: { grant_status: 'Agreement Executed' } },
  { stageId: '29569048-1326-489b-b658-4b7bebeba54b', label: 'Direct Grant · Receipts Received', activityType: 'grant', defaults: { grant_status: 'Receipts Received' } },
  { stageId: '37c0eae6-c3cd-4b2c-b5bb-7cf56248da0b', label: 'Direct Grant · Closed Won', activityType: 'grant', defaults: { grant_status: 'Closed Won' } },
];

(async () => {
  const { upsertRoute, listRoutes } = await import('../lib/activities/routes');
  const { OPPORTUNITY_SOURCE } = await import('../lib/activities/sources/opportunityStage');

  console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply to write)\n');
  for (const s of SEEDS) {
    const extra = [
      s.program?.length ? `program=${s.program.join('+')}` : '',
      s.defaults?.grant_status ? `status="${s.defaults.grant_status}"` : '',
      s.defaults?.impliesAcceptance ? 'implies-acceptance' : '',
    ].filter(Boolean).join(' ');
    console.log(`  ${s.label.padEnd(40)} → ${s.activityType.padEnd(19)} ${extra}`);
    if (!APPLY) continue;
    await upsertRoute({
      source: OPPORTUNITY_SOURCE,
      matchKind: 'pipeline_stage',
      matchId: s.stageId,
      matchLabel: s.label,
      activityType: s.activityType,
      program: s.program,
      defaults: s.defaults,
      enabled: true,
    });
  }
  if (APPLY) {
    const all = await listRoutes({ force: true });
    console.log(`\n✅ ${all.filter((r) => r.source === OPPORTUNITY_SOURCE).length} opportunity rule(s) configured (${all.length} rules total).`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
