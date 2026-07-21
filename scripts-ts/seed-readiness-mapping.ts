// scripts-ts/seed-readiness-mapping.ts — add the readiness sync rows to the Contact → Team set.
//
//   npx vite-node scripts-ts/seed-readiness-mapping.ts             # DRY-RUN (prints the plan)
//   npx vite-node scripts-ts/seed-readiness-mapping.ts --apply     # write the rows to the DB
//   npx vite-node scripts-ts/seed-readiness-mapping.ts --set <id>  # target a specific set id
//
// Idempotent: rows already present (matched by source→target) are skipped, so it is safe to
// re-run. Adds the 7 readiness fields + the membership Tags mirror to whatever Contact→Team
// mapping set already exists (found by source=contact + Wix collection "Team"). The Wix columns
// already exist; MULTIPLE_OPTIONS→ARRAY_STRING coercion is handled by the sync's coerceToWix, so
// no per-row transform is needed (matches the existing rows, which set none).
// Reads .env.local. Needs POSTGRES_URL / DATABASE_URL.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WixMappingRow, WixMappingSet, WixMappingSetInput } from '../lib/mapping/wixTypes';

function loadEnvLocal() {
  try {
    const txt = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* ok */ }
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean { return process.argv.includes(`--${name}`); }

/** The readiness rows to ensure exist on the Contact → Team set (GHL field → Wix column). */
const READINESS_ROWS: WixMappingRow[] = [
  { sourceFieldKey: 'contact.service_areas', targetColumnKey: 'serviceAreas' },
  { sourceFieldKey: 'contact.mrl_stops', targetColumnKey: 'mrlStops' },
  { sourceFieldKey: 'contact.trl_stops', targetColumnKey: 'trlStops' },
  { sourceFieldKey: 'contact.crl_stops', targetColumnKey: 'crlStops' },
  { sourceFieldKey: 'contact.investor_readiness_stops', targetColumnKey: 'investorReadinessStops' },
  { sourceFieldKey: 'contact.readiness_confidence', targetColumnKey: 'readinessConfidence' },
  { sourceFieldKey: 'contact.readiness_rationale', targetColumnKey: 'readinessRationale' },
  { sourceFieldKey: 'contact.website_team_tags', targetColumnKey: 'arraystring' },
];

function toInput(set: WixMappingSet, rows: WixMappingRow[]): WixMappingSetInput {
  return {
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
  };
}

(async () => {
  loadEnvLocal();
  const apply = flag('apply');
  const { getWixStore } = await import('../lib/mapping/wixStore');
  const store = getWixStore();

  // Find the target set: explicit --set, else the enabled contact set on the "Team" collection.
  const setId = arg('set');
  let set: WixMappingSet | null = null;
  if (setId) {
    set = await store.getSet(setId);
  } else {
    const contactSets = await store.setsForSource('contact');
    set = contactSets.find((s) => s.wixCollectionId === 'Team')
      ?? contactSets.find((s) => /team/i.test(s.name))
      ?? null;
  }
  if (!set) {
    console.error('No Contact → Team mapping set found. Pass --set <id>, or create it at /wix-sync first.');
    process.exit(1);
  }

  console.log(`Target set: "${set.name}" (${set.id}) → Wix collection "${set.wixCollectionId}", ${set.rows.length} existing row(s).`);

  const have = new Set(set.rows.map((r) => `${r.sourceFieldKey}→${r.targetColumnKey}`));
  const toAdd = READINESS_ROWS.filter((r) => !have.has(`${r.sourceFieldKey}→${r.targetColumnKey}`));
  const already = READINESS_ROWS.filter((r) => have.has(`${r.sourceFieldKey}→${r.targetColumnKey}`));

  if (already.length) console.log(`Already present (${already.length}): ${already.map((r) => r.targetColumnKey).join(', ')}`);
  if (toAdd.length === 0) {
    console.log('Nothing to add — all readiness rows already present. ✅');
    process.exit(0);
  }
  console.log(`Rows to ADD (${toAdd.length}):`);
  for (const r of toAdd) console.log(`  ${r.sourceFieldKey}  ->  ${r.targetColumnKey}`);

  if (!apply) {
    console.log('\nDRY-RUN — re-run with --apply to write these rows to the mapping set.');
    process.exit(0);
  }

  const nextRows = [...set.rows, ...toAdd];
  const updated = await store.saveSet(set.id, toInput(set, nextRows));
  console.log(`\n✅ Saved. Set now has ${updated.rows.length} rows (version ${updated.version}).`);
  process.exit(0);
})().catch((e) => { console.error('SEED FAILED:', e?.stack ?? e); process.exit(2); });
