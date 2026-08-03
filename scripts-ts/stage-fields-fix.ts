// scripts-ts/stage-fields-fix.ts — one-time schema fix on custom_objects.business_stage (Zach, 2026-07-31):
//   1. DELETE `source_contact_id` (unused; batch scoring has no single triggering contact).
//   2. Convert `churchill_substage` TEXT → SINGLE_OPTIONS [III-D, III-G, N/A]. GHL can't change a field's
//      type in place, so this deletes the TEXT field and recreates it (same fieldKey) as a picklist.
// Idempotent: skips a step already in the target state. DRY-RUN by default; pass --apply --yes to execute.
//
//   npx vite-node scripts-ts/stage-fields-fix.ts            # dry-run (prints the plan)
//   npx vite-node scripts-ts/stage-fields-fix.ts --apply --yes
//
// Reads .env.local; targets GHL_TARGET (default live).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';
const flag = (n: string) => process.argv.includes(`--${n}`);

const OBJECT = 'custom_objects.business_stage';
const SUBSTAGE_KEY = `${OBJECT}.churchill_substage`;
const SOURCE_KEY = `${OBJECT}.source_contact_id`;
const SUBSTAGE_OPTIONS = ['III-D', 'III-G', 'N/A'];

(async () => {
  const apply = flag('apply');
  if (apply && !flag('yes')) { console.error('Refusing to APPLY without --yes. Re-run with --apply --yes.'); process.exit(1); }
  const { ghl } = await import('../lib/ghl/client');
  const { getObjectKeyFieldCatalog, createObjectField } = await import('../lib/ghl/customFields');
  const client = ghl();

  const before = await getObjectKeyFieldCatalog(OBJECT, client);
  const substage = before.byKey[SUBSTAGE_KEY];
  const source = before.byKey[SOURCE_KEY];
  console.log(`Target: ${OBJECT} (${apply ? 'APPLY' : 'DRY-RUN'})`);
  console.log(`  source_contact_id : ${source ? `present (id=${source.id}) → DELETE` : 'absent → skip'}`);
  console.log(`  churchill_substage: ${substage ? `present (id=${substage.id}, ${substage.dataType})` : 'absent'}` +
    (substage?.dataType === 'SINGLE_OPTIONS' ? ' → already SINGLE_OPTIONS, skip' : ' → DELETE + recreate SINGLE_OPTIONS [III-D, III-G, N/A]'));

  if (!apply) { console.log('\nDry-run only. Re-run with --apply --yes to execute.'); process.exit(0); }

  const del = (id: string) => client.request({ method: 'DELETE', path: `/custom-fields/${id}` });

  if (source) { await del(source.id); console.log(`Deleted source_contact_id (${source.id}).`); }

  if (substage && substage.dataType !== 'SINGLE_OPTIONS') {
    const parentId = substage.parentId;
    if (!parentId) throw new Error('churchill_substage has no parent folder — cannot recreate; set a folder in GHL first.');
    await del(substage.id);
    console.log(`Deleted churchill_substage TEXT (${substage.id}).`);
    const newId = await createObjectField({
      objectKey: OBJECT, parentId, bareKey: 'churchill_substage', name: 'Churchill Substage',
      dataType: 'SINGLE_OPTIONS', options: SUBSTAGE_OPTIONS,
    }, client);
    console.log(`Recreated churchill_substage as SINGLE_OPTIONS (${newId}).`);
  } else if (substage?.dataType === 'SINGLE_OPTIONS') {
    console.log('churchill_substage already SINGLE_OPTIONS — nothing to do.');
  }

  const after = await getObjectKeyFieldCatalog(OBJECT, client);
  const s = after.byKey[SUBSTAGE_KEY];
  console.log(`\nVerify: source_contact_id ${after.byKey[SOURCE_KEY] ? 'STILL PRESENT ✗' : 'gone ✓'} | ` +
    `churchill_substage ${s ? `${s.dataType} options=[${(s.options ?? []).map((o) => o.label).join(', ')}]` : 'MISSING ✗'}`);
  process.exit(0);
})().catch((e) => { console.error('FIELD FIX FAILED:', e?.stack ?? e); process.exit(2); });
