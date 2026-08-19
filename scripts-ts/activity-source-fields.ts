// scripts-ts/activity-source-fields.ts — add the two SOURCE-KEY fields the ingestion layer needs.
//
// WHY (Sprint B, docs/sprints/activity-tracking.md): every activity source fires more than once for
// the same real-world event — GHL retries webhooks, forms get resubmitted, nightly syncs re-run. With
// no natural key, each retry creates another activity, and duplicate activities DOUBLE-COUNT in
// funder reports. So each record carries where it came from and that source's own id, and ingestion
// does find-or-create against them:
//
//   activity_source     SINGLE_OPTIONS  which adapter wrote the record
//   source_record_id    TEXT            that source's id (appointment id, submission id, …)
//
// Server-side lookup on the pair is one call (probed live 2026-08-19):
//   POST /objects/custom_objects.activities/records/search
//   { filters: [{ field: 'properties.source_record_id', operator: 'eq', value }] }
//
// Idempotent: re-running reports "exists" and writes nothing. Dry-run by default (house rule).
//   npx vite-node scripts-ts/activity-source-fields.ts            # dry run
//   npx vite-node scripts-ts/activity-source-fields.ts --apply

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';

const APPLY = process.argv.includes('--apply');
const OBJ = 'custom_objects.activities';
const CORE_FOLDER = 'Activity Info';

/** One option per ingestion adapter, plus the manual back-up path. */
const SOURCE_OPTIONS = ['Appointment', 'Form', 'Wix Attendance', 'Opportunity Stage', 'Manual'];

const PLAN = [
  { bareKey: 'activity_source', name: '[SYNC] Activity Source', dataType: 'SINGLE_OPTIONS', options: SOURCE_OPTIONS },
  { bareKey: 'source_record_id', name: '[SYNC] Source Record ID', dataType: 'TEXT' as const },
];

(async () => {
  const { getFieldCatalog, createObjectField } = await import('../lib/ghl/customFields');
  const { getGhlConfig } = await import('../lib/ghl/config');

  const cfg = getGhlConfig();
  console.log(`target=${cfg.target} location=${cfg.locationId} object=${OBJ}`);
  console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply to write)\n');

  const catalog = await getFieldCatalog(OBJ);
  const folder = catalog.folders?.find((f) => f.name === CORE_FOLDER);
  if (!folder) throw new Error(`folder "${CORE_FOLDER}" not found on ${OBJ} — a field must have a parentId`);

  let created = 0;
  let existing = 0;
  for (const f of PLAN) {
    const found = catalog.byKey[`${OBJ}.${f.bareKey}`];
    if (found) {
      existing++;
      console.log(`  exists   ${f.bareKey.padEnd(18)} ${found.dataType} "${found.name}"`);
      if (found.dataType !== f.dataType) {
        console.log(`    ⚠️  type is ${found.dataType}, expected ${f.dataType} — reconcile by hand`);
      }
      continue;
    }
    if (!APPLY) {
      console.log(`  create   ${f.bareKey.padEnd(18)} ${f.dataType}${'options' in f && f.options ? ` [${f.options.join(' | ')}]` : ''}`);
      continue;
    }
    const id = await createObjectField({
      objectKey: OBJ,
      parentId: folder.id,
      bareKey: f.bareKey,
      name: f.name,
      dataType: f.dataType,
      ...('options' in f && f.options ? { options: f.options } : {}),
      showInForms: false,
    });
    created++;
    console.log(`  created  ${f.bareKey.padEnd(18)} ${f.dataType} id=${id}`);
  }

  console.log(`\n${APPLY ? 'created' : 'would create'} ${APPLY ? created : PLAN.length - existing} · already present ${existing}`);
})().catch((e) => { console.error(e); process.exit(1); });
