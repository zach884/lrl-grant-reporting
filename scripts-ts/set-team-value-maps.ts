// scripts-ts/set-team-value-maps.ts — configure the per-row valueMap for the Team set's reference
// columns, so the labels Wix names differently stop being dropped.
//
//   npx vite-node scripts-ts/set-team-value-maps.ts            # DRY-RUN
//   npx vite-node scripts-ts/set-team-value-maps.ts --apply     # write it
//
// Verified against live 2026-08-18:
//   GHL contact.programs   : Local · Sales and Marketing · ManuTech Incubator · i4.0 Accelerator
//   Wix  Programs.title_fld: LOCAL · Sales and Marketing Accelerator · ManuTech Incubator ·
//                            Industry 4.0 Accelerator · Lean Rocket Lab · Co-Working
//   GHL contact.collectives   : Lean Startup · Mainstreet · Manufacturing Tech
//   Wix  Collectives.title_fld: Lean Startup · Mainstreet · Manufacturing
//
// `Local → LOCAL` is NOT listed here on purpose — the reference resolver matches case-insensitively.
// Only genuinely different NAMES belong in a valueMap.
//
// Preserves everything else on the set (gate/visibility/writeback and all other rows) by reading the
// live set and editing only the two rows in question — the live sets have drifted past what
// set-team-gate.ts would write, so a full re-save from a hardcoded shape would DROP rows.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';

const MAPS: Record<string, Record<string, string>> = {
  program: {
    'Sales and Marketing': 'Sales and Marketing Accelerator',
    'i4.0 Accelerator': 'Industry 4.0 Accelerator',
  },
  collectives: {
    'Manufacturing Tech': 'Manufacturing',
  },
};

(async () => {
  const apply = process.argv.includes('--apply');
  const { getWixStore } = await import('../lib/mapping/wixStore');
  const store = getWixStore();

  const sets = await store.setsForSource('contact');
  const set = sets.find((s) => s.wixCollectionId === 'Team');
  if (!set) { console.error('No Contact → Team set found.'); process.exit(1); }

  console.log(`Set "${set.name}" (${set.id}) — ${set.rows.length} rows`);
  const rows = set.rows.map((r) => {
    const want = MAPS[r.targetColumnKey];
    if (!want) return r;
    const merged = { ...(r.valueMap ?? {}), ...want };
    const changed = JSON.stringify(merged) !== JSON.stringify(r.valueMap ?? {});
    console.log(`  ${r.targetColumnKey}: ${changed ? 'SET' : 'already set'} → ${JSON.stringify(merged)}`);
    return { ...r, valueMap: merged };
  });

  const touched = rows.filter((r, i) => JSON.stringify(r) !== JSON.stringify(set.rows[i])).length;
  if (!touched) { console.log('\nNothing to change.'); process.exit(0); }
  if (!apply) { console.log(`\nDRY-RUN — ${touched} row(s) would change. Re-run with --apply.`); process.exit(0); }

  await store.saveSet(set.id, {
    name: set.name, sourceObject: set.sourceObject, wixSiteId: set.wixSiteId,
    wixCollectionId: set.wixCollectionId, matchSourceField: set.matchSourceField,
    matchTargetColumn: set.matchTargetColumn, policy: set.policy, createPolicy: set.createPolicy,
    gate: set.gate, secondaryMatch: set.secondaryMatch, writebackField: set.writebackField,
    visibility: set.visibility, enabled: set.enabled, rows,
  } as any);

  const after = (await store.setsForSource('contact')).find((s) => s.id === set.id);
  console.log(`\n✅ saved — ${after?.rows.length} rows (was ${set.rows.length})`);
  for (const r of after?.rows ?? []) if (r.valueMap) console.log(`   ${r.targetColumnKey}: ${JSON.stringify(r.valueMap)}`);
  console.log(`   gate=${after?.gate?.field ?? 'NONE'} · visibility=${JSON.stringify(after?.visibility)} · writeback=${after?.writebackField}`);
  process.exit(0);
})().catch((e) => { console.error('SET VALUE MAPS FAILED:', e?.stack ?? e); process.exit(2); });
