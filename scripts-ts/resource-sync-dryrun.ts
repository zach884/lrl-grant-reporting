// scripts-ts/resource-sync-dryrun.ts — Phase C proof: dry-run the object-agnostic Wix sync for ONE
// Resource record through an ad-hoc custom_objects.resources → Import1 mapping set. NO writes.
//
//   npx vite-node scripts-ts/resource-sync-dryrun.ts [--only <recordId>]
//
// Proves syncRecordToWix reads a GHL custom-object record, coerces the mapped fields, finds the linked
// Wix row by ghlResourceId, and produces a coherent plan — reusing the exact engine the contact sync
// uses. (The real persisted mapping set + gate come in Phase D.) Reads .env.local.

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
function arg(name: string): string | undefined { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; }

const RES_OBJ = 'custom_objects.resources';
const RES_OBJID = '6a590064ad413a5431fc728e';
const WIX_RES = 'Import1';

(async () => {
  loadEnvLocal();
  const { ghl } = await import('../lib/ghl/client');
  const { getCatalog } = await import('../lib/ghl/catalogCache');
  const { getWixCollectionSchema } = await import('../lib/wix/catalogCache');
  const { syncRecordToWix } = await import('../lib/wix-sync/sync');
  const c = ghl();

  // Pick a record (first, or --only <id>).
  const only = arg('only');
  let recordId = only;
  let name = '';
  if (!recordId) {
    const d: any = await c.request({ method: 'POST', path: `/objects/${RES_OBJID}/records/search`, autoLocation: false, body: { locationId: process.env.GHL_LOCATION_ID, query: '', page: 1, pageLimit: 1, searchAfter: [], sort: [{ field: 'updatedAt', direction: 'desc' }] } });
    const r = (d.records ?? d.data ?? [])[0];
    recordId = r?.id ?? r?._id; name = (r?.properties ?? {}).resources ?? '';
  }
  if (!recordId) { console.error('No resource record found.'); process.exit(1); }

  const catalog = await getCatalog(RES_OBJ, { force: true });
  const schema = await getWixCollectionSchema(WIX_RES, true);

  // Ad-hoc mapping set (no gate here so the plan is visible regardless of resource_status; the gate
  // machinery is shared with the contact sync + covered by tests). Match id ↔ ghlResourceId.
  const set: any = {
    id: 'adhoc', name: 'Resource → Wix Resources (dry-run)', sourceObject: RES_OBJ,
    wixSiteId: process.env.WIX_SITE_ID ?? '', wixCollectionId: WIX_RES,
    matchSourceField: 'id', matchTargetColumn: 'ghlResourceId',
    policy: 'overwrite', createPolicy: 'find_or_create',
    visibility: { mode: 'publishState' }, writebackField: `${RES_OBJ}.wix_resource_row_id`,
    enabled: true, version: 1, updatedAt: new Date().toISOString(),
    rows: [
      { sourceFieldKey: 'resources', targetColumnKey: 'companyResourceName' },
      { sourceFieldKey: 'category', targetColumnKey: 'category' },
      { sourceFieldKey: 'sub_category', targetColumnKey: 'subCategory' },
      { sourceFieldKey: 'short_description', targetColumnKey: 'shortDescription' },
      { sourceFieldKey: 'full_description', targetColumnKey: 'description' },
      { sourceFieldKey: 'website', targetColumnKey: 'website' },
      { sourceFieldKey: 'email', targetColumnKey: 'email' },
      { sourceFieldKey: 'slug', targetColumnKey: 'slug' },
      { sourceFieldKey: 'service_areas', targetColumnKey: 'serviceAreas', transform: 'arrayFromMultiSelect' },
      { sourceFieldKey: 'mrl_stops', targetColumnKey: 'mrlStops', transform: 'arrayFromMultiSelect' },
      { sourceFieldKey: 'trl_stops', targetColumnKey: 'trlStops', transform: 'arrayFromMultiSelect' },
      { sourceFieldKey: 'crl_stops', targetColumnKey: 'crlStops', transform: 'arrayFromMultiSelect' },
      { sourceFieldKey: 'investor_readiness_stops', targetColumnKey: 'investorReadinessStops', transform: 'arrayFromMultiSelect' },
      { sourceFieldKey: 'readiness_confidence', targetColumnKey: 'readinessConfidence' },
      { sourceFieldKey: 'readiness_rationale', targetColumnKey: 'readinessRationale' },
    ],
  };

  console.log(`Dry-run sync: resource "${name || recordId}" (${recordId}) → Wix ${WIX_RES}\n`);
  const r = await syncRecordToWix(RES_OBJ, recordId, set, catalog, schema, { apply: false });
  console.log('action     :', r.action, r.note ? `(${r.note})` : '');
  console.log('matched row:', r.itemId ?? '(none — would insert)');
  console.log('unchanged  :', r.unchanged);
  console.log('would write:', r.written.map((w: any) => `${w.targetColumn}${w.via !== 'value' ? ` [${w.via}]` : ''}`).join(', ') || '(none)');
  if (r.skipped.length) console.log('skipped    :', r.skipped.map((s: any) => `${s.targetColumn}: ${s.reason}`).join(' · '));
  console.log(`\n✅ Object-agnostic engine read the resource record + matched its Wix row by ghlResourceId. No writes (dry-run).`);
  process.exit(0);
})().catch((e) => { console.error('RESOURCE SYNC DRY-RUN FAILED:', e?.stack ?? e); process.exit(2); });
