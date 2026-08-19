// scripts-ts/seed-form-routes.ts — which GHL form becomes which activity (Zach, 2026-08-19).
//
//   Client Reporting Form        ed03BbRGWrc6Ugtwr9JB  → metrics
//   Direct Grant Application     0d8irJ6Ay6VQFajG06Go  → grant  (merges with the Direct Grants pipeline)
//
//   npx vite-node scripts-ts/seed-form-routes.ts            # dry run
//   npx vite-node scripts-ts/seed-form-routes.ts --apply

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';
const APPLY = process.argv.includes('--apply');

const DIRECT_GRANTS_PIPELINE = 'trGMRtrlkvUG1UtMbuMJ';

const SEEDS = [
  { matchId: 'ed03BbRGWrc6Ugtwr9JB', label: 'Client Reporting Form', activityType: 'metrics' },
  // pipelineId lets the ingester find the contact's grant opportunity, so the form's detail lands on
  // the SAME activity the pipeline stamps `grant_status` on — one grant, one record.
  { matchId: '0d8irJ6Ay6VQFajG06Go', label: 'Direct Grant Application', activityType: 'grant', defaults: { pipelineId: DIRECT_GRANTS_PIPELINE } },
];

(async () => {
  const { upsertRoute, listRoutes } = await import('../lib/activities/routes');
  const { FORM_SOURCE } = await import('../lib/activities/sources/form');
  console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply to write)\n');
  for (const s of SEEDS) {
    console.log(`  ${s.label.padEnd(28)} ${s.matchId}  → ${s.activityType}`);
    if (!APPLY) continue;
    await upsertRoute({ source: FORM_SOURCE, matchKind: 'form', matchId: s.matchId, matchLabel: s.label, activityType: s.activityType, defaults: (s as any).defaults, enabled: true });
  }
  if (APPLY) {
    const all = await listRoutes({ force: true });
    console.log(`\n✅ ${all.filter((r) => r.source === FORM_SOURCE).length} form rule(s) configured (${all.length} total).`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
