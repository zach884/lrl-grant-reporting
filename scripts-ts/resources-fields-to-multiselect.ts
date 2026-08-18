// scripts-ts/resources-fields-to-multiselect.ts — flip the readiness fields on
// custom_objects.resources from TEXT back to MULTIPLE_OPTIONS, and migrate every record's values.
//
//   npx vite-node scripts-ts/resources-fields-to-multiselect.ts                     # DRY-RUN + backup
//   npx vite-node scripts-ts/resources-fields-to-multiselect.ts --apply --yes       # stops only
//   npx vite-node scripts-ts/resources-fields-to-multiselect.ts --apply --yes --include-service-areas
//   npx vite-node scripts-ts/resources-fields-to-multiselect.ts --rewrite-only --apply --yes
//                                                    ^ re-run the value pass from the backup file
//
// WHY: the 4 stop fields were recreated as TEXT on 2026-08-17 so tagging would work at all (object
// multi-selects looked unwritable). They are updatable via an {add,remove} modifier, so the fields
// can go back to being real dropdowns — which is what Zach wants so staff can edit resource records
// safely instead of hand-editing ';'-joined strings.
//
// DESTRUCTIVE: a type change requires DELETE + recreate of the field. Deleting with the same
// fieldKey preserves stored values, but they stay in the old TEXT shape, so the value rewrite MUST
// run in the same pass. Order of operations:
//
//   1. BACKUP every record's current values to a JSON file, and refuse to continue if it fails.
//   2. DELETE + recreate each field as MULTIPLE_OPTIONS (stops: keys 1..N · service areas: labels).
//   3. REWRITE each record from the BACKUP (not from a post-flip read — the stored value is in the
//      wrong shape at that point and must not be trusted as the source of truth). Each field is
//      WIPED before its {add:[keys]}, because the preserved TEXT string makes the field unwritable
//      (GHL 500s on add, 400s on remove) until it is cleared.
//   4. READ BACK and verify every record holds a proper array. Mismatches are reported, not hidden.
//
// If step 3 or 4 goes wrong, re-run with --rewrite-only: the backup is the source of truth.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';

const flag = (n: string) => process.argv.includes(`--${n}`);
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };

const RES_OBJ = 'custom_objects.resources';
const RES_OBJID = '6a590064ad413a5431fc728e';
const FOLDER = 'VuQMCzWXPkuNXqG2fCna';
const BACKUP_DIR = join(process.cwd(), 'reports');
const BACKUP_FILE = join(BACKUP_DIR, 'resources-readiness-values-backup.json');

/** MRL runs 1–10; TRL/CRL/IRL run 1–9 (see lib/enrichment/data/readiness.ts). */
const STOP_FIELDS = [
  { key: 'mrl_stops', name: 'MRL Stops', max: 10 },
  { key: 'trl_stops', name: 'TRL Stops', max: 9 },
  { key: 'crl_stops', name: 'CRL Stops', max: 9 },
  { key: 'investor_readiness_stops', name: 'Investor Readiness Stops', max: 9 },
];

type Backup = Record<string, Record<string, string[]>>; // recordId -> bareKey -> values

/** Split a stored value (TEXT-era delimited string, or already an array) into clean parts. */
function toParts(v: unknown): string[] {
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v.map(String) : String(v).split(/[,;]/);
  const out: string[] = [];
  for (const p of arr.map((s) => s.trim()).filter(Boolean)) if (!out.includes(p)) out.push(p);
  return out;
}

(async () => {
  const apply = flag('apply');
  const rewriteOnly = flag('rewrite-only');
  const includeAreas = flag('include-service-areas');
  if (apply && !flag('yes')) {
    console.error('Refusing to APPLY without --yes (DELETES + recreates live GHL fields).');
    process.exit(1);
  }

  const { ghl } = await import('../lib/ghl/client');
  const { getCatalog } = await import('../lib/ghl/catalogCache');
  const { createObjectField } = await import('../lib/ghl/customFields');
  const { SERVICES } = await import('../lib/enrichment/data/readiness');

  const c = ghl();
  const serviceLabels = Object.values(SERVICES) as string[];

  const targets = [
    ...STOP_FIELDS.map((f) => ({ ...f, options: Array.from({ length: f.max }, (_, i) => String(i + 1)) })),
    ...(includeAreas ? [{ key: 'service_areas', name: 'Service Areas', max: 0, options: serviceLabels }] : []),
  ];

  console.log(`Fields to flip → MULTIPLE_OPTIONS: ${targets.map((t) => t.key).join(', ')}`);
  if (!includeAreas) console.log('(service_areas EXCLUDED — pass --include-service-areas to include it)');

  // ── 1. load records + BACKUP ────────────────────────────────────────────────────────────────
  let backup: Backup;

  if (rewriteOnly) {
    if (!existsSync(BACKUP_FILE)) { console.error(`No backup at ${BACKUP_FILE} — cannot rewrite.`); process.exit(1); }
    backup = JSON.parse(readFileSync(BACKUP_FILE, 'utf8'));
    console.log(`\nLoaded backup for ${Object.keys(backup).length} records from ${BACKUP_FILE}`);
  } else {
    const recs: any[] = [];
    for (let page = 1; page <= 10; page++) {
      const d: any = await c.request({
        method: 'POST', path: `/objects/${RES_OBJID}/records/search`, autoLocation: false,
        body: { locationId: process.env.GHL_LOCATION_ID, query: '', page, pageLimit: 100, searchAfter: [], sort: [{ field: 'updatedAt', direction: 'desc' }] },
      });
      const r = d.records ?? d.data ?? []; recs.push(...r); if (r.length < 100) break;
    }
    backup = {};
    for (const r of recs) {
      const id = r.id ?? r._id;
      const props = r.properties ?? {};
      const entry: Record<string, string[]> = {};
      for (const t of targets) entry[t.key] = toParts(props[t.key]);
      backup[id] = entry;
    }
    const nonEmpty = Object.values(backup).filter((e) => Object.values(e).some((v) => v.length)).length;
    console.log(`\nRead ${recs.length} records · ${nonEmpty} have at least one value to migrate`);

    mkdirSync(BACKUP_DIR, { recursive: true });
    writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2));
    const written = existsSync(BACKUP_FILE);
    console.log(`${written ? '✅' : '❌'} Backup ${written ? 'written to' : 'FAILED at'} ${BACKUP_FILE}`);
    if (!written) { console.error('Refusing to continue without a backup.'); process.exit(1); }

    // Show a sample so the plan is reviewable before anything destructive happens.
    const sampleId = Object.keys(backup).find((id) => Object.values(backup[id]).some((v) => v.length));
    if (sampleId) console.log(`Sample ${sampleId}: ${JSON.stringify(backup[sampleId])}`);
  }

  if (!apply) {
    console.log('\nWould, for each field: DELETE the TEXT field, recreate as MULTIPLE_OPTIONS, then');
    console.log(`rewrite ${Object.keys(backup).length} records via {add:[keys]} and verify each read-back.`);
    console.log('\nDRY-RUN — re-run with --apply --yes.');
    process.exit(0);
  }

  // ── 2. flip the field types ─────────────────────────────────────────────────────────────────
  if (!rewriteOnly) {
    const cat: any = await getCatalog(RES_OBJ, { force: true });
    const byKey = new Map(cat.fields.map((f: any) => [String(f.fieldKey).replace(`${RES_OBJ}.`, ''), f]));
    console.log('\n── flipping field types ──');
    for (const t of targets) {
      const def: any = byKey.get(t.key);
      if (def?.dataType === 'MULTIPLE_OPTIONS') { console.log(`  ${t.key}: already MULTIPLE_OPTIONS — skip`); continue; }
      if (def) {
        console.log(`  ${t.key}: ${def.dataType} (${def.id}) → delete + recreate MULTIPLE_OPTIONS (${t.options.length} options)`);
        await c.request({ method: 'DELETE', path: `/custom-fields/${def.id}` });
      } else {
        console.log(`  ${t.key}: missing → create MULTIPLE_OPTIONS`);
      }
      const id = await createObjectField({ objectKey: RES_OBJ, parentId: FOLDER, bareKey: t.key, name: t.name, dataType: 'MULTIPLE_OPTIONS', options: t.options });
      console.log(`    ✅ created (${id})`);
    }
  }

  // Re-read the catalog so we know the ACTUAL option keys GHL assigned (it can normalize them).
  const cat2: any = await getCatalog(RES_OBJ, { force: true });
  const defByKey = new Map(cat2.fields.map((f: any) => [String(f.fieldKey).replace(`${RES_OBJ}.`, ''), f]));
  console.log('\n── option keys as GHL stored them ──');
  for (const t of targets) {
    const d: any = defByKey.get(t.key);
    const o = (d?.options ?? []).slice(0, 4).map((x: any) => `${x.key}="${x.label}"`).join(' · ');
    console.log(`  ${t.key}: ${d?.dataType} · ${(d?.options ?? []).length} options · ${o}${(d?.options ?? []).length > 4 ? ' …' : ''}`);
  }

  // ── 3. rewrite values from the backup ───────────────────────────────────────────────────────
  const { resolveOptionKeys } = await import('../lib/ghl/coerce');
  console.log('\n── rewriting record values ──');
  let wrote = 0, empty = 0, failed = 0;
  const ids = Object.keys(backup);
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const todo = limit ? ids.slice(0, limit) : ids;

  // A type flip PRESERVES the old TEXT value, and a leftover string POISONS the field: GHL then
  // 500s on `{add:…}` ("Something went wrong") and 400s on `{remove:…}` ("includes values that
  // don't match what's saved"). Verified live 2026-08-17. So each field must be WIPED first — and
  // the wipe primitive is the very footgun documented elsewhere: a plain string on a modifier-typed
  // field returns 200 and stores null. Here that is exactly what we want.
  //   wipe (plain string) → {add:[keys]} → proper array.
  let skippedOk = 0;
  for (const id of todo) {
    // Read the current state so the pass is idempotent and resumable.
    let props: Record<string, unknown> = {};
    try {
      const d: any = await c.request({ path: `/objects/${RES_OBJ}/records/${id}` });
      props = (d.record ?? d)?.properties ?? {};
    } catch (e: any) {
      failed++;
      console.log(`  ❌ ${id}: read failed ${String(e?.message ?? e).slice(0, 160)}`);
      continue;
    }

    const wipe: Record<string, unknown> = {};
    const add: Record<string, unknown> = {};
    for (const t of targets) {
      // Desired state comes from the BACKUP, never from the current (possibly poisoned) value.
      const desired = resolveOptionKeys(backup[id]?.[t.key] ?? [], (defByKey.get(t.key) as any)?.options);
      if (!desired.length) continue;
      const cur = props[t.key];
      const curArr = Array.isArray(cur) ? cur.map(String) : null;
      if (curArr && curArr.length === desired.length && [...curArr].sort().join('|') === [...desired].sort().join('|')) {
        continue; // already a correct array — leave it alone
      }
      if (cur != null && cur !== '') wipe[t.key] = ''; // clear the stale/partial value first
      add[t.key] = { add: desired };
    }

    if (!Object.keys(add).length) { skippedOk++; continue; }
    try {
      if (Object.keys(wipe).length) {
        await c.request({ method: 'PUT', path: `/objects/${RES_OBJ}/records/${id}`, body: { properties: wipe } });
      }
      await c.request({ method: 'PUT', path: `/objects/${RES_OBJ}/records/${id}`, body: { properties: add } });
      wrote++;
    } catch (e: any) {
      failed++;
      console.log(`  ❌ ${id}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  console.log(`  wrote ${wrote} · already-correct ${skippedOk} · nothing-to-write ${empty} · failed ${failed}`);

  // ── 4. verify read-back ─────────────────────────────────────────────────────────────────────
  console.log('\n── verifying ──');
  let ok = 0; const bad: string[] = [];
  for (const id of todo) {
    const expected = backup[id] ?? {};
    if (!Object.values(expected).some((v) => v.length)) continue;
    try {
      const d: any = await c.request({ path: `/objects/${RES_OBJ}/records/${id}` });
      const props = (d.record ?? d)?.properties ?? {};
      let good = true;
      for (const t of targets) {
        const want = resolveOptionKeys(expected[t.key] ?? [], (defByKey.get(t.key) as any)?.options);
        if (!want.length) continue;
        const got = props[t.key];
        const gotArr = Array.isArray(got) ? got.map(String) : toParts(got);
        const same = want.length === gotArr.length && [...want].sort().join('|') === [...gotArr].sort().join('|');
        // An array is required, not just equal contents — a lingering string means the flip
        // left the value in the old shape.
        if (!same || !Array.isArray(got)) {
          good = false;
          bad.push(`${id} ${t.key}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
        }
      }
      if (good) ok++;
    } catch (e: any) {
      bad.push(`${id}: read-back failed ${e?.message ?? e}`);
    }
  }
  console.log(`  ✅ ${ok} records verified`);
  if (bad.length) {
    console.log(`  ❌ ${bad.length} problem(s):`);
    for (const b of bad.slice(0, 20)) console.log(`     ${b}`);
    console.log(`\nBackup is intact at ${BACKUP_FILE} — fix and re-run with --rewrite-only --apply --yes.`);
    process.exit(1);
  }
  console.log('\n✅ Done. Next: re-run the resource sync twice and confirm noop, then check the map.');
  process.exit(0);
})().catch((e) => { console.error('FIELD FLIP FAILED:', e?.stack ?? e); process.exit(2); });
