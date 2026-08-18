// scripts-ts/restore-resource-logo-row.ts — put the `resource_logo → logo` mapping row back.
//
//   npx vite-node scripts-ts/restore-resource-logo-row.ts          # DRY-RUN
//   npx vite-node scripts-ts/restore-resource-logo-row.ts --apply  # append the row
//
// The row was removed on 2026-08-17 because there was no image equality guard: with 91 resources
// carrying a GHL logo, every sync re-imported all 91 into the Wix Media Manager. The guard now
// exists (lib/wix-sync/sync.ts + the `logoSrc` companion column), so the row is safe to restore.
//
// PREREQUISITE: the `logoSrc` column must exist on the collection —
//   npx vite-node scripts-ts/wix-image-guard-columns.ts --all-image-columns --apply
// This script refuses to run without it, because restoring the row first is exactly what caused
// the 91-re-import problem.
//
// APPENDS ONLY. It reads the live set and adds the one missing row, because the live set has
// drifted from set-resource-gate.ts (rows added directly on 2026-08-17) and re-saving that
// script's ROWS would silently DROP the rows it doesn't know about. Idempotent.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';

const RES_OBJ = 'custom_objects.resources';
const WIX_RES = 'Import1';
const SOURCE_FIELD = 'resource_logo';
const TARGET_COLUMN = 'logo';
const COMPANION = `${TARGET_COLUMN}Src`;

(async () => {
  const apply = process.argv.includes('--apply');

  const { getWixStore } = await import('../lib/mapping/wixStore');
  const { getCollectionSchema } = await import('../lib/wix/collections');

  const store = getWixStore();
  const set = (await store.setsForSource(RES_OBJ)).find((s) => s.wixCollectionId === WIX_RES);
  if (!set) {
    console.error('No Resources → Wix set found.');
    process.exit(1);
  }

  const schema = await getCollectionSchema(set.wixCollectionId);
  const keys = new Set(schema.columns.map((c) => c.key));

  if (!keys.has(TARGET_COLUMN)) {
    console.error(`Collection ${WIX_RES} has no \`${TARGET_COLUMN}\` column.`);
    process.exit(1);
  }
  if (!keys.has(COMPANION)) {
    console.error(
      `REFUSING: \`${COMPANION}\` does not exist on ${WIX_RES}, so image writes would not be\n` +
      `equality-guarded and every sync would re-import all 91 logos (the exact problem this row\n` +
      `was removed for). Run first:\n` +
      `  npx vite-node scripts-ts/wix-image-guard-columns.ts --all-image-columns --apply`,
    );
    process.exit(1);
  }

  console.log(`Set "${set.name}" (${set.id}) — ${set.rows.length} rows · guard column \`${COMPANION}\` present ✓`);

  if (set.rows.some((r) => r.targetColumnKey === TARGET_COLUMN)) {
    console.log(`\n✓ Row \`${SOURCE_FIELD} → ${TARGET_COLUMN}\` already present. Nothing to do.`);
    process.exit(0);
  }

  const rows = [...set.rows, { sourceFieldKey: SOURCE_FIELD, targetColumnKey: TARGET_COLUMN }];
  console.log(`\nWould append: ${SOURCE_FIELD} → ${TARGET_COLUMN}  (rows ${set.rows.length} → ${rows.length})`);

  if (!apply) {
    console.log('\nDRY-RUN — re-run with --apply to append the row.');
    process.exit(0);
  }

  // Re-save the set with its OWN current config plus the new row (never a hardcoded shape — the
  // gate/visibility/writeback must survive untouched; see the 1,391-junk-row incident).
  await store.saveSet(set.id, {
    name: set.name,
    sourceObject: set.sourceObject,
    wixSiteId: set.wixSiteId,
    wixCollectionId: set.wixCollectionId,
    matchSourceField: set.matchSourceField,
    matchTargetColumn: set.matchTargetColumn,
    policy: set.policy,
    createPolicy: set.createPolicy,
    gate: set.gate,
    secondaryMatch: set.secondaryMatch,
    writebackField: set.writebackField,
    visibility: set.visibility,
    enabled: set.enabled,
    rows,
  } as any);

  const after = (await store.setsForSource(RES_OBJ)).find((s) => s.id === set.id);
  const ok = !!after?.rows.some((r) => r.targetColumnKey === TARGET_COLUMN);
  console.log(`\n${ok ? '✅' : '❌'} Row ${ok ? 'restored' : 'NOT restored'} — set now has ${after?.rows.length} rows.`);
  console.log(`   gate=${after?.gate?.field ?? 'NONE'} · visibility=${JSON.stringify(after?.visibility)} · writeback=${after?.writebackField}`);
  if (!ok) process.exit(1);
  console.log('\nNext: sync once (existing logos are ADOPTED — logoSrc stamped, no re-import),');
  console.log('then sync again and confirm every record reports noop.');
  process.exit(0);
})().catch((e) => { console.error('RESTORE LOGO ROW FAILED:', e?.stack ?? e); process.exit(2); });
