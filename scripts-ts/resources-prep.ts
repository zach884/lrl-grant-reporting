// scripts-ts/resources-prep.ts — Phase A step 1 of the Resources/TAP sprint (docs/sprints/resources-tap.md).
//
//   npx vite-node scripts-ts/resources-prep.ts            # AUDIT (read-only): what's missing on each side
//   npx vite-node scripts-ts/resources-prep.ts --apply    # CREATE the missing GHL fields + Wix columns
//
// Adds the readiness pipeline's fields to the GHL `custom_objects.resources` object and the matching
// columns to the Wix `Import1` (Resources) collection. Idempotent — skips anything already present.
// The 90↔90 record LINK is a separate step (scripts-ts/resources-link.ts). Reads .env.local.

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

const RES_OBJ = 'custom_objects.resources';
const RES_FIELDS_FOLDER = 'VuQMCzWXPkuNXqG2fCna'; // the resources object's field folder (parentId)
const WIX_RES = 'Import1';

// GHL fields to add (bare key). options is the label list for OPTION types.
type GhlField = { key: string; name: string; type: string; options?: string[]; note?: string };
function ghlTarget(): GhlField[] {
  return [
    // NOTE: TEXT (delimited list), NOT MULTIPLE_OPTIONS — GHL custom-object MULTIPLE_OPTIONS can't be
    // set via update (only at record create), so the tagger writes a '; '/';'-joined string and the
    // Wix sync splits it into an ARRAY_STRING column.
    { key: 'service_areas', name: 'Service Areas', type: 'TEXT', note: 'delimited service labels' },
    { key: 'mrl_stops', name: 'MRL Stops', type: 'TEXT' },
    { key: 'trl_stops', name: 'TRL Stops', type: 'TEXT' },
    { key: 'crl_stops', name: 'CRL Stops', type: 'TEXT' },
    { key: 'investor_readiness_stops', name: 'Investor Readiness Stops', type: 'TEXT' },
    { key: 'readiness_confidence', name: 'Readiness Confidence', type: 'SINGLE_OPTIONS', options: ['High', 'Medium', 'Low'] },
    { key: 'readiness_rationale', name: 'Readiness Rationale', type: 'LARGE_TEXT' },
    { key: 'resource_status', name: 'Resource Status', type: 'SINGLE_OPTIONS', options: ['Pending', 'Approved', 'Published', 'Hidden'], note: 'sync gate' },
    { key: 'wix_resource_row_id', name: 'Wix Resource Row Id', type: 'TEXT', note: 'writeback of the Wix _id' },
  ];
}

// Wix columns to add on Import1.
const WIX_TARGET: Array<{ key: string; displayName: string; type: string }> = [
  { key: 'serviceAreas', displayName: 'Service Areas', type: 'ARRAY_STRING' },
  { key: 'mrlStops', displayName: 'MRL Stops', type: 'ARRAY_STRING' },
  { key: 'trlStops', displayName: 'TRL Stops', type: 'ARRAY_STRING' },
  { key: 'crlStops', displayName: 'CRL Stops', type: 'ARRAY_STRING' },
  { key: 'investorReadinessStops', displayName: 'Investor Readiness Stops', type: 'ARRAY_STRING' },
  { key: 'readinessConfidence', displayName: 'Readiness Confidence', type: 'TEXT' },
  { key: 'readinessRationale', displayName: 'Readiness Rationale', type: 'TEXT' },
  { key: 'ghlResourceId', displayName: 'GHL Resource Id', type: 'TEXT' },
];

(async () => {
  loadEnvLocal();
  const apply = flag('apply');
  const { getCatalog } = await import('../lib/ghl/catalogCache');
  const { getWixCollectionSchema } = await import('../lib/wix/catalogCache');
  const { createObjectField } = await import('../lib/ghl/customFields');
  const { createField } = await import('../lib/wix/collections');

  const GHL_TARGET = ghlTarget();

  console.log(`=== Resources/TAP · Phase A prep (${apply ? 'APPLY' : 'AUDIT'}) ===\n`);

  // GHL fields
  const cat: any = await getCatalog(RES_OBJ, { force: true });
  const haveGhl = new Set(cat.fields.map((f: any) => String(f.fieldKey).replace(`${RES_OBJ}.`, '')));
  const ghlMissing = GHL_TARGET.filter((t) => !haveGhl.has(t.key));
  console.log(`GHL ${RES_OBJ}: ${cat.fields.length} fields; ${ghlMissing.length} to create.`);
  for (const f of ghlMissing) {
    if (!apply) { console.log(`  ➕ ${f.key} (${f.type})${f.options ? ` [${f.options.length} opts]` : ''}${f.note ? ' — ' + f.note : ''}`); continue; }
    try {
      const id = await createObjectField({ objectKey: RES_OBJ, parentId: RES_FIELDS_FOLDER, bareKey: f.key, name: f.name, dataType: f.type, options: f.options });
      console.log(`  ✅ created ${f.key} (${id})`);
    } catch (e: any) { console.log(`  ❌ ${f.key}: ${e?.status} ${JSON.stringify(e?.body ?? e?.message).slice(0, 200)}`); }
  }

  // Wix columns
  const schema: any = await getWixCollectionSchema(WIX_RES, true);
  const haveWix = new Set(schema.columns.map((c: any) => c.key));
  const wixMissing = WIX_TARGET.filter((t) => !haveWix.has(t.key));
  console.log(`\nWix ${WIX_RES}: ${schema.columns.length} columns; ${wixMissing.length} to create.`);
  for (const col of wixMissing) {
    if (!apply) { console.log(`  ➕ ${col.key} (${col.type})`); continue; }
    try {
      await createField(WIX_RES, { key: col.key, displayName: col.displayName, type: col.type });
      console.log(`  ✅ created ${col.key}`);
    } catch (e: any) { console.log(`  ❌ ${col.key}: ${e?.message ?? e}`); }
  }

  console.log(`\n${apply ? 'Done. Next: reconcile-link the 90↔90 (scripts-ts/resources-link.ts).' : 'AUDIT only — re-run with --apply to create. Then run resources-link.ts.'}`);
  process.exit(0);
})().catch((e) => { console.error('PREP FAILED:', e?.stack ?? e); process.exit(2); });
