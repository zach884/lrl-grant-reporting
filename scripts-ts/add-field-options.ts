// scripts-ts/add-field-options.ts — ADD options to an existing object picklist, without losing any.
//
// Sprint B phase 4 needs a 7th `activity_type` option (`program_acceptance`) and two new
// `program__grant_association` options (LOCAL, SAMA — the field's name literally covers both
// programs and grants). GHL has no "append an option" call: the update replaces the whole list, so
// the ONLY safe way is read → append → write → read back and prove nothing was dropped.
//
// That matters more than usual here: dropping an option from a live picklist silently orphans every
// record already holding it.
//
//   npx vite-node scripts-ts/add-field-options.ts                 # dry run, shows the merged list
//   npx vite-node scripts-ts/add-field-options.ts --apply

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';

const APPLY = process.argv.includes('--apply');
const OBJ = 'custom_objects.activities';

/** bareKey -> option LABELS to ensure exist. */
const PLAN: Array<{ bareKey: string; add: string[] }> = [
  // The 7th activity type: an opportunity reaching an "accepted" pipeline stage.
  { bareKey: 'activity_type', add: ['Program Acceptance'] },
  // LRL's own programs, alongside the funder grants already there.
  { bareKey: 'program__grant_association', add: ['LOCAL', 'SAMA'] },
];

(async () => {
  const { ghl } = await import('../lib/ghl/client');
  const { getFieldCatalog } = await import('../lib/ghl/customFields');
  const client = ghl();

  const catalog = await getFieldCatalog(OBJ);
  console.log(`target=${process.env.GHL_TARGET} object=${OBJ}`);
  console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply to write)\n');

  for (const step of PLAN) {
    const def = catalog.byKey[`${OBJ}.${step.bareKey}`];
    if (!def) { console.log(`  ⚠️  ${step.bareKey}: field not found`); continue; }

    const existing = def.options ?? [];
    const have = new Set(existing.map((o) => o.label.trim().toLowerCase()));
    const missing = step.add.filter((label) => !have.has(label.trim().toLowerCase()));

    console.log(`▸ ${step.bareKey} (${def.dataType}) — ${existing.length} existing option(s)`);
    console.log(`    existing: ${existing.map((o) => o.key).join(' | ') || '(none)'}`);
    if (!missing.length) { console.log('    ✅ nothing to add\n'); continue; }
    console.log(`    adding:   ${missing.join(' | ')}`);

    if (!APPLY) { console.log('    (dry run)\n'); continue; }

    // Send the FULL list — existing first, in order, then the new ones. Existing options are sent
    // with their stored key so GHL keeps them identical; a changed key would orphan stored values.
    const body = {
      locationId: client.locationId,
      name: def.name,
      options: [
        ...existing.map((o) => ({ key: o.key, label: o.label })),
        ...missing.map((label) => ({ key: label.toLowerCase().replace(/\s+/g, '_'), label })),
      ],
    };
    await client.request({ method: 'PUT', path: `/custom-fields/${def.id}`, autoLocation: false, body });

    // Read back and prove no option was lost.
    const after = await getFieldCatalog(OBJ, client);
    const now = after.byKey[`${OBJ}.${step.bareKey}`]?.options ?? [];
    const nowKeys = new Set(now.map((o) => o.key));
    const dropped = existing.filter((o) => !nowKeys.has(o.key));
    console.log(`    now:      ${now.map((o) => o.key).join(' | ')}`);
    if (dropped.length) {
      console.error(`    ❌ LOST OPTIONS: ${dropped.map((o) => o.key).join(', ')} — records holding them are now orphaned`);
      process.exit(2);
    }
    const added = missing.filter((label) => now.some((o) => o.label.toLowerCase() === label.toLowerCase()));
    console.log(`    ✅ added ${added.length}/${missing.length}, kept all ${existing.length} existing\n`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
