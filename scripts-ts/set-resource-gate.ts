// scripts-ts/set-resource-gate.ts — Phase D: persist the Resource → Wix Resources mapping set + gate.
//
//   npx vite-node scripts-ts/set-resource-gate.ts            # DRY-RUN (prints the set it would write)
//   npx vite-node scripts-ts/set-resource-gate.ts --apply    # create/update the set
//
// Creates the custom_objects.resources → Wix `Import1` mapping set with the SAME gate shape as Team:
//   Pending → skip · Approved → upsert (+publish, write back Published) · Published → update · Hidden → hide
// visibility publishState; match id ↔ ghlResourceId (all 90 already linked); writeback the Wix _id →
// custom_objects.resources.wix_resource_row_id. Rows push the descriptive fields (GHL becomes source of
// truth — equal today, so a no-op) + the readiness fields the map needs. Idempotent. Reads .env.local.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WixMappingSetInput } from '../lib/mapping/wixTypes';

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

const RES_OBJ = 'custom_objects.resources';
const WIX_RES = 'Import1';

const ROWS = [
  // Descriptive (GHL → Wix; equal today, so no-op — makes GHL the source of truth going forward).
  { sourceFieldKey: 'resources', targetColumnKey: 'companyResourceName' },
  { sourceFieldKey: 'category', targetColumnKey: 'category' },
  { sourceFieldKey: 'sub_category', targetColumnKey: 'subCategory' },
  { sourceFieldKey: 'short_description', targetColumnKey: 'shortDescription' },
  { sourceFieldKey: 'full_description', targetColumnKey: 'description' },
  { sourceFieldKey: 'website', targetColumnKey: 'website' },
  { sourceFieldKey: 'email', targetColumnKey: 'email' },
  { sourceFieldKey: 'slug', targetColumnKey: 'slug' },
  // Readiness (what the map needs for placement).
  { sourceFieldKey: 'service_areas', targetColumnKey: 'serviceAreas', transform: 'arrayFromMultiSelect' as const },
  { sourceFieldKey: 'mrl_stops', targetColumnKey: 'mrlStops', transform: 'arrayFromMultiSelect' as const },
  { sourceFieldKey: 'trl_stops', targetColumnKey: 'trlStops', transform: 'arrayFromMultiSelect' as const },
  { sourceFieldKey: 'crl_stops', targetColumnKey: 'crlStops', transform: 'arrayFromMultiSelect' as const },
  { sourceFieldKey: 'investor_readiness_stops', targetColumnKey: 'investorReadinessStops', transform: 'arrayFromMultiSelect' as const },
  { sourceFieldKey: 'readiness_confidence', targetColumnKey: 'readinessConfidence' },
  { sourceFieldKey: 'readiness_rationale', targetColumnKey: 'readinessRationale' },
];

function buildInput(): WixMappingSetInput {
  return {
    name: 'Resources → Wix Resources',
    sourceObject: RES_OBJ,
    wixSiteId: process.env.WIX_SITE_ID ?? '',
    wixCollectionId: WIX_RES,
    matchSourceField: 'id',
    matchTargetColumn: 'ghlResourceId',
    policy: 'overwrite',
    createPolicy: 'find_or_create',
    gate: {
      field: `${RES_OBJ}.resource_status`,
      actions: { Approved: 'upsert', Published: 'update', Hidden: 'hide', Pending: 'skip' },
      onPublishSetStatus: 'Published',
    },
    secondaryMatch: null,
    writebackField: `${RES_OBJ}.wix_resource_row_id`,
    visibility: { mode: 'publishState' },
    enabled: true,
    rows: ROWS,
  };
}

(async () => {
  loadEnvLocal();
  const apply = flag('apply');
  const { getWixStore } = await import('../lib/mapping/wixStore');
  const store = getWixStore();
  const input = buildInput();

  const existing = (await store.setsForSource(RES_OBJ)).find((s) => s.wixCollectionId === WIX_RES);
  console.log(`Resource → Wix set: ${existing ? `exists (${existing.id})` : 'not found — will create'}`);
  console.log('Gate      :', JSON.stringify(input.gate));
  console.log('Visibility:', JSON.stringify(input.visibility), '| writeback:', input.writebackField, '| match id ↔ ghlResourceId');
  console.log('Rows      :', input.rows.length);

  if (!apply) { console.log('\nDRY-RUN — re-run with --apply to write the set.'); process.exit(0); }

  const saved = existing ? await store.saveSet(existing.id, input) : await store.createSet(input);
  console.log(`\n✅ ${existing ? 'Updated' : 'Created'} set "${saved.name}" (${saved.id}) · gate on ${saved.gate?.field} · ${saved.rows.length} rows.`);
  console.log('Note: all 90 resources have empty resource_status → gate SKIPS them until status is set (safe).');
  process.exit(0);
})().catch((e) => { console.error('SET RESOURCE GATE FAILED:', e?.stack ?? e); process.exit(2); });
