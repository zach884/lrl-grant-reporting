// scripts-ts/wix-image-guard-columns.ts — provision the image-provenance columns the sync's
// equality guard needs, so a re-run stops re-importing every image into the Wix Media Manager.
//
//   npx vite-node scripts-ts/wix-image-guard-columns.ts            # DRY-RUN (prints what it would add)
//   npx vite-node scripts-ts/wix-image-guard-columns.ts --apply    # create the missing columns
//   npx vite-node scripts-ts/wix-image-guard-columns.ts --set <id> # limit to one mapping set
//   npx vite-node scripts-ts/wix-image-guard-columns.ts --all-image-columns  # every IMAGE column,
//        not just currently-mapped ones (use before adding a mapping row for an image column)
//
// WHY: Wix re-hosts a file on import, so the stored `wix:image://…` value can never be compared to
// the GHL source url — there is nothing to diff, and the sync therefore re-imported unconditionally
// (126 duplicate uploads in the 13 days to 2026-08-17). For each IMAGE column a mapping set writes,
// this adds a hidden TEXT column `<imageColumn>Src` that records the GHL source url alongside the
// image. lib/wix-sync/sync.ts picks these up automatically by name — no config to update.
//
// Idempotent: an existing column is left alone. Adding a column does not touch any row's data, and
// rows keep their images — the first sync after this ADOPTS each existing image (stamps its source
// url without re-importing), so the run after that is a clean noop.

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
function flag(name: string): boolean { return process.argv.includes(`--${name}`); }
function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

(async () => {
  loadEnvLocal();
  const apply = flag('apply');
  const onlySet = opt('set');

  const { getWixStore } = await import('../lib/mapping/wixStore');
  const { getCollectionSchema, createField } = await import('../lib/wix/collections');

  const store = getWixStore();
  // listSets returns summaries (no rows) — re-read each one in full so we can see its mapped columns.
  const summaries = (await store.listSets()).filter((s) => (onlySet ? s.id === onlySet : s.enabled));
  const sets = (await Promise.all(summaries.map((s) => store.getSet(s.id)))).filter(
    (s): s is NonNullable<typeof s> => !!s,
  );
  if (sets.length === 0) {
    console.log('No matching mapping sets.');
    process.exit(0);
  }

  let missing = 0;
  let created = 0;

  for (const set of sets) {
    const schema = await getCollectionSchema(set.wixCollectionId);
    const colByKey = new Map(schema.columns.map((c) => [c.key, c] as const));

    // Every IMAGE column this set writes to — or, with --all-image-columns, every IMAGE column on
    // the collection. Use the flag to provision a companion BEFORE adding the mapping row that will
    // write it (the `resource_logo → logo` row was removed precisely because the guard didn't exist,
    // so its column can't be discovered from the set's rows).
    const imageColumns = flag('all-image-columns')
      ? schema.columns.filter((col) => String(col.type) === 'IMAGE')
      : set.rows
          .map((row) => colByKey.get(row.targetColumnKey))
          .filter((col): col is NonNullable<typeof col> => !!col && String(col.type) === 'IMAGE');

    if (imageColumns.length === 0) continue;

    console.log(`\n${set.name}  (collection ${set.wixCollectionId})`);
    for (const col of imageColumns) {
      const companion = `${col.key}Src`;
      if (colByKey.has(companion)) {
        console.log(`  ✓ ${col.key} → ${companion} already present`);
        continue;
      }
      missing += 1;
      console.log(`  ${apply ? '+' : '·'} ${col.key} → ${companion} ${apply ? 'CREATING' : 'MISSING'}`);
      if (!apply) continue;
      try {
        await createField(set.wixCollectionId, {
          key: companion,
          displayName: `${col.displayName} source URL`,
          type: 'TEXT',
          description:
            'Set by the GHL sync: the GHL source URL of the image in ' +
            `"${col.displayName}". Used to detect whether the image actually changed — ` +
            'do not edit by hand.',
        });
        created += 1;
      } catch (e: any) {
        console.error(`  ✗ failed to create ${companion}: ${e?.message ?? e}`);
      }
    }
  }

  if (missing === 0) {
    console.log('\nAll image columns already have a companion source column. Nothing to do.');
  } else if (!apply) {
    console.log(`\nDRY-RUN — ${missing} column(s) missing. Re-run with --apply to create them.`);
  } else {
    console.log(`\n✅ Created ${created}/${missing} companion column(s).`);
    console.log('Next: run the sync once — existing images are ADOPTED (source url stamped, no');
    console.log('re-import), and the run after that should report noop with 0 media imports.');
  }
  process.exit(0);
})().catch((e) => { console.error('IMAGE GUARD COLUMNS FAILED:', e?.stack ?? e); process.exit(2); });
