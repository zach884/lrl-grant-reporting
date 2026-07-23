// scripts-ts/rename-service-label.ts — one-off: rename a service-area label everywhere it's stored.
//
//   npx vite-node scripts-ts/rename-service-label.ts            # DRY-RUN (counts what it would change)
//   npx vite-node scripts-ts/rename-service-label.ts --apply    # do it
//
// Renames OLD → NEW across all four stores so the Milestone Map + CMS show the new label:
//   1. GHL contact `service_areas` field: swap the string in picklistOptions (PUT + verify).
//   2. GHL contacts (Team): rewrite each record's service_areas array (the option value is the string).
//   3. GHL resources (custom_objects.resources): replace in service_areas (TEXT).
//   4. Wix Team + Import1 `serviceAreas` (ARRAY_STRING): replace the string so the live map updates now.
// The taxonomy code (lib/enrichment/data/readiness.ts) is already changed, so future tagging uses NEW.
// Aborts before any record write if the field-option PUT doesn't verify. Reads .env.local.

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

const OLD = 'SBIR/STTR & Grants';
const NEW = 'Non-dilutive Funding';
const CONTACT_FIELD_ID = '4cwXyHXVmKae5hWrZLCT'; // contact.service_areas (MULTIPLE_OPTIONS)
const RES_OBJ = 'custom_objects.resources';
const RES_OBJID = '6a590064ad413a5431fc728e';

const swapArr = (a: unknown) => (Array.isArray(a) ? a.map((x) => (x === OLD ? NEW : x)) : a);
const swapStr = (s: unknown) => String(s ?? '').split(OLD).join(NEW);

(async () => {
  loadEnvLocal();
  const apply = flag('apply');
  const { ghl } = await import('../lib/ghl/client');
  const { getContactFieldCatalog } = await import('../lib/ghl/customFields');
  const { enumerateAllContacts } = await import('../lib/ghl/contacts');
  const { writeRecordFields } = await import('../lib/ghl/writeRecord');
  const { wix } = await import('../lib/wix/client');
  const { patchItem } = await import('../lib/wix/collections');
  const c = ghl();
  const LOC = c.locationId;
  console.log(`Rename "${OLD}" → "${NEW}" | ${apply ? 'APPLY' : 'DRY-RUN'}\n`);

  // --- 1) contact field picklistOptions ---
  const fieldRes: any = await c.request({ path: `/locations/${LOC}/customFields/${CONTACT_FIELD_ID}`, autoLocation: false });
  const field = fieldRes.customField ?? fieldRes;
  const opts: string[] = (field.picklistOptions ?? []).slice();
  const hasOld = opts.indexOf(OLD) !== -1;
  console.log(`1) contact.service_areas options: ${opts.length}; contains OLD: ${hasOld}`);
  if (apply && hasOld) {
    const newOpts = opts.map((o) => (o === OLD ? NEW : o));
    await c.request({ method: 'PUT', path: `/locations/${LOC}/customFields/${CONTACT_FIELD_ID}`, autoLocation: false, body: { name: field.name, options: newOpts } });
    // verify
    const v: any = await c.request({ path: `/locations/${LOC}/customFields/${CONTACT_FIELD_ID}`, autoLocation: false });
    const vo: string[] = (v.customField ?? v).picklistOptions ?? [];
    if (vo.indexOf(NEW) === -1 || vo.indexOf(OLD) !== -1 || vo.length !== opts.length) {
      console.error(`   ❌ field verify FAILED (len ${vo.length}, hasNEW ${vo.indexOf(NEW) !== -1}, hasOLD ${vo.indexOf(OLD) !== -1}). Aborting before record writes.`);
      console.error('   options now:', JSON.stringify(vo));
      process.exit(2);
    }
    console.log(`   ✅ option renamed (verified: ${vo.length} options, OLD gone, NEW present).`);
  }

  // --- 2) contact records (Team) ---
  const catalog = await getContactFieldCatalog();
  const contacts = await enumerateAllContacts();
  const affContacts = contacts.filter((ct) => {
    const cf = (ct.customFields || []).find((x: any) => x.id === CONTACT_FIELD_ID);
    return Array.isArray(cf?.value) && cf!.value.indexOf(OLD) !== -1;
  });
  console.log(`2) contacts with "${OLD}": ${affContacts.length}`);
  if (apply) {
    for (const ct of affContacts) {
      const cf = (ct.customFields || []).find((x: any) => x.id === CONTACT_FIELD_ID);
      const next = swapArr(cf!.value);
      await writeRecordFields('contact', ct.id, { 'contact.service_areas': next }, catalog, c);
      console.log(`   ✅ ${ct.id}`);
    }
  }

  // --- 3) resource records (TEXT) ---
  const resCatalog = await (await import('../lib/ghl/catalogCache')).getCatalog(RES_OBJ, { force: true });
  const recs: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const d: any = await c.request({ method: 'POST', path: `/objects/${RES_OBJID}/records/search`, autoLocation: false, body: { locationId: LOC, query: '', page, pageLimit: 100, searchAfter: [], sort: [{ field: 'updatedAt', direction: 'desc' }] } });
    const r = d.records ?? d.data ?? []; recs.push(...r); if (r.length < 100) break;
  }
  const affRes = recs.filter((r) => String((r.properties || {}).service_areas || '').indexOf(OLD) !== -1);
  console.log(`3) resources with "${OLD}": ${affRes.length}`);
  if (apply) {
    for (const r of affRes) {
      const id = r.id ?? r._id;
      const next = swapStr((r.properties || {}).service_areas);
      await writeRecordFields(RES_OBJ, id, { [`${RES_OBJ}.service_areas`]: next }, resCatalog, c);
      console.log(`   ✅ ${id}`);
    }
  }

  // --- 4) Wix serviceAreas (Team + Import1) ---
  for (const coll of ['Team', 'Import1']) {
    const d: any = await wix().request({ method: 'POST', path: '/wix-data/v2/items/query', body: { dataCollectionId: coll, query: { paging: { limit: 1000 } }, publishPluginOptions: { includeDraftItems: true } } });
    const items = (d.dataItems ?? d.items ?? []).map((it: any) => it.data ?? it);
    const aff = items.filter((m: any) => Array.isArray(m.serviceAreas) && m.serviceAreas.indexOf(OLD) !== -1);
    console.log(`4) Wix ${coll} rows with "${OLD}": ${aff.length}`);
    if (apply) {
      for (const m of aff) {
        await patchItem(coll, m._id, [{ fieldPath: 'serviceAreas', value: swapArr(m.serviceAreas) }]);
        console.log(`   ✅ ${coll}/${m._id}`);
      }
    }
  }

  console.log(apply ? '\n✅ Done. Map + CMS now show the new label.' : '\nDRY-RUN — re-run with --apply.');
  process.exit(0);
})().catch((e) => { console.error('RENAME FAILED:', e?.stack ?? e); process.exit(2); });
