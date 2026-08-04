// scripts-ts/rename-stage-rationale.ts — rename the combined stage-rationale field's DISPLAY name to
// "Stage Rationale" on the company (business) + contact objects, keeping the fieldKey stable so the
// sync mappings that reference `…latest_tech_stage_rationale` keep working.
//
//   npx vite-node scripts-ts/rename-stage-rationale.ts            # DRY-RUN (prints the plan)
//   npx vite-node scripts-ts/rename-stage-rationale.ts --apply    # rename + verify
//
// Reads .env.local; target via GHL_TARGET (default live). Idempotent — re-running is a no-op.

import { readFileSync } from 'node:fs';
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
const flag = (n: string) => process.argv.includes(`--${n}`);

const NEW_NAME = 'Stage Rationale';
const FIELD_SUFFIX = 'latest_tech_stage_rationale';

(async () => {
  loadEnvLocal();
  if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';
  const apply = flag('apply');

  const { getBusinessFieldCatalog, getContactFieldCatalog, updateObjectFieldName, updateLocationFieldName } =
    await import('../lib/ghl/customFields');

  const [biz, con] = await Promise.all([getBusinessFieldCatalog(), getContactFieldCatalog()]);
  const pick = (cat: any) => cat.fields.find((f: any) => f.fieldKey.endsWith('.' + FIELD_SUFFIX) || f.fieldKey === FIELD_SUFFIX);
  const targets = [
    { label: 'business (company)', field: pick(biz), rename: updateObjectFieldName },
    { label: 'contact', field: pick(con), rename: updateLocationFieldName },
  ] as const;

  console.log(`Rename "${FIELD_SUFFIX}" display name -> "${NEW_NAME}"  (${apply ? 'APPLY' : 'DRY-RUN'}, target=${process.env.GHL_TARGET})\n`);
  let missing = false;
  for (const t of targets) {
    if (!t.field) { console.error(`  ✗ ${t.label}: field not found (suffix ${FIELD_SUFFIX})`); missing = true; continue; }
    const same = t.field.name === NEW_NAME;
    console.log(`  ${t.label}: id=${t.field.id} fieldKey=${t.field.fieldKey}`);
    console.log(`      "${t.field.name}" -> "${NEW_NAME}"${same ? '  (already renamed — skip)' : ''}`);
  }
  if (missing) process.exit(1);
  if (!apply) { console.log('\nDRY-RUN only. Re-run with --apply to rename.'); process.exit(0); }

  console.log('');
  for (const t of targets) {
    if (!t.field || t.field.name === NEW_NAME) continue;
    const res = await t.rename(t.field.id, NEW_NAME);
    const ok = res?.name === NEW_NAME;
    console.log(`  ${ok ? '✓' : '✗'} ${t.label}: now "${res?.name ?? '(unknown)'}" (fieldKey=${res?.fieldKey ?? t.field.fieldKey})`);
    if (!ok) { console.error(`     Verification failed — GHL returned ${JSON.stringify(res)}`); process.exitCode = 2; }
  }
  process.exit(process.exitCode ?? 0);
})();
