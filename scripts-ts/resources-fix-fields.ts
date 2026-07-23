// scripts-ts/resources-fix-fields.ts — one-off: convert the 5 multi-value readiness fields on
// custom_objects.resources from MULTIPLE_OPTIONS (unsettable via update) to TEXT.
//
//   npx vite-node scripts-ts/resources-fix-fields.ts            # DRY-RUN
//   npx vite-node scripts-ts/resources-fix-fields.ts --apply    # delete MULTIPLE_OPTIONS + recreate TEXT
//
// GHL custom-object MULTIPLE_OPTIONS fields are settable only at record CREATE, so the tagger's
// updates to service_areas + the 4 stop fields silently dropped. They hold NO data (the writes never
// landed), so deleting + recreating as TEXT is safe. Reads .env.local.

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
const FOLDER = 'VuQMCzWXPkuNXqG2fCna';
const FIELDS: Array<{ key: string; name: string }> = [
  { key: 'service_areas', name: 'Service Areas' },
  { key: 'mrl_stops', name: 'MRL Stops' },
  { key: 'trl_stops', name: 'TRL Stops' },
  { key: 'crl_stops', name: 'CRL Stops' },
  { key: 'investor_readiness_stops', name: 'Investor Readiness Stops' },
];

(async () => {
  loadEnvLocal();
  const apply = flag('apply');
  const { ghl } = await import('../lib/ghl/client');
  const { getCatalog } = await import('../lib/ghl/catalogCache');
  const { createObjectField } = await import('../lib/ghl/customFields');
  const c = ghl();

  const cat: any = await getCatalog(RES_OBJ, { force: true });
  const byKey = new Map(cat.fields.map((f: any) => [String(f.fieldKey).replace(`${RES_OBJ}.`, ''), f]));

  for (const f of FIELDS) {
    const def: any = byKey.get(f.key);
    if (!def) { console.log(`  ${f.key}: not found — will create TEXT`); if (apply) { const id = await createObjectField({ objectKey: RES_OBJ, parentId: FOLDER, bareKey: f.key, name: f.name, dataType: 'TEXT' }); console.log(`    ✅ created TEXT (${id})`); } continue; }
    if (def.dataType === 'TEXT') { console.log(`  ${f.key}: already TEXT — skip`); continue; }
    console.log(`  ${f.key}: ${def.dataType} (${def.id}) → delete + recreate TEXT`);
    if (!apply) continue;
    try {
      await c.request({ method: 'DELETE', path: `/custom-fields/${def.id}` });
      const id = await createObjectField({ objectKey: RES_OBJ, parentId: FOLDER, bareKey: f.key, name: f.name, dataType: 'TEXT' });
      console.log(`    ✅ recreated TEXT (${id})`);
    } catch (e: any) { console.log(`    ❌ ${e?.status} ${JSON.stringify(e?.body ?? e?.message).slice(0, 200)}`); }
  }
  console.log(apply ? '\nDone.' : '\nDRY-RUN — re-run with --apply.');
  process.exit(0);
})().catch((e) => { console.error('FIX FIELDS FAILED:', e?.stack ?? e); process.exit(2); });
