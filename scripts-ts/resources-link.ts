// scripts-ts/resources-link.ts — Phase A LINK/RECONCILE: pair existing GHL resource records with
// existing Wix Resources rows and stamp the link both ways. Goal: NO unlinked items on either side.
//
//   npx vite-node scripts-ts/resources-link.ts            # DRY-RUN: match report only (no writes)
//   npx vite-node scripts-ts/resources-link.ts --apply    # stamp ghlResourceId (Wix) + wix id (GHL);
//                                                          # create the counterpart for true orphans
//
// The records already exist on both sides (90 ≈ 90) — we are NOT bulk-creating. Match precedence:
// slug (where both have one) → exact normalized name → fuzzy normalized name (reported, not auto-linked
// unless --fuzzy). Ambiguous (duplicate names) are reported for review, never auto-linked. Reads .env.local.

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

const RES_OBJID = '6a590064ad413a5431fc728e';
const WIX_RES = 'Import1';

/** Normalize a name for matching: lowercase, & → and, drop non-alphanumerics, collapse spaces. */
function norm(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
/** Fuzzier: also strip parentheticals and common suffixes (llc/inc). Used only for the fuzzy pass. */
function normFuzzy(s: unknown): string {
  return norm(String(s ?? '').replace(/\([^)]*\)/g, ' ')).replace(/\b(llc|inc|corp|co|ltd)\b/g, '').trim().replace(/\s+/g, ' ');
}

(async () => {
  loadEnvLocal();
  const { ghl } = await import('../lib/ghl/client');
  const { wix } = await import('../lib/wix/client');
  const c = ghl();
  const LOC = process.env.GHL_LOCATION_ID;

  // --- load GHL records ---
  const ghlRecs: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const d: any = await c.request({ method: 'POST', path: `/objects/${RES_OBJID}/records/search`, autoLocation: false, body: { locationId: LOC, query: '', page, pageLimit: 100, searchAfter: [], sort: [{ field: 'updatedAt', direction: 'desc' }] } });
    const recs = d.records ?? d.data ?? [];
    ghlRecs.push(...recs);
    if (recs.length < 100) break;
  }
  const ghl2 = ghlRecs.map((r) => {
    const p = r.properties ?? {};
    return { id: r.id ?? r._id, name: p.resources ?? p.name ?? '', slug: p.slug ?? '', website: p.website ?? '', wixId: p.wix_resource_row_id ?? '' };
  });

  // --- load Wix rows ---
  const wd: any = await wix().request({ method: 'POST', path: '/wix-data/v2/items/query', body: { dataCollectionId: WIX_RES, query: { paging: { limit: 1000 } }, publishPluginOptions: { includeDraftItems: true } } });
  const wixItems = (wd.dataItems ?? wd.items ?? []).map((it: any) => it.data ?? it);
  const wix2 = wixItems.map((m: any) => ({ id: m._id, name: m.companyResourceName ?? m.title ?? '', slug: m.slug ?? '', website: m.website ?? '', ghlId: m.ghlResourceId ?? '' }));

  console.log(`GHL records: ${ghl2.length} · Wix rows: ${wix2.length}\n`);

  // --- index Wix by slug + name for lookup; track consumption ---
  const bySlug = new Map<string, any[]>();
  const byName = new Map<string, any[]>();
  const byFuzzy = new Map<string, any[]>();
  for (const w of wix2) {
    if (w.slug) (bySlug.get(norm(w.slug)) ?? bySlug.set(norm(w.slug), []).get(norm(w.slug))!).push(w);
    (byName.get(norm(w.name)) ?? byName.set(norm(w.name), []).get(norm(w.name))!).push(w);
    (byFuzzy.get(normFuzzy(w.name)) ?? byFuzzy.set(normFuzzy(w.name), []).get(normFuzzy(w.name))!).push(w);
  }

  const usedWix = new Set<string>();
  const pairs: Array<{ g: any; w: any; via: string }> = [];
  const ambiguous: Array<{ g: any; via: string; n: number }> = [];

  function tryMatch(g: any, index: Map<string, any[]>, key: string, via: string): boolean {
    const cands = (index.get(key) ?? []).filter((w) => !usedWix.has(w.id));
    if (cands.length === 1) { pairs.push({ g, w: cands[0], via }); usedWix.add(cands[0].id); return true; }
    if (cands.length > 1) { ambiguous.push({ g, via, n: cands.length }); return false; }
    return false;
  }

  const unmatchedGhl: any[] = [];
  // Pass 1: slug. Pass 2: exact name. Pass 3: fuzzy (only auto-links with --fuzzy).
  for (const g of ghl2) {
    if (g.slug && tryMatch(g, bySlug, norm(g.slug), 'slug')) continue;
    if (tryMatch(g, byName, norm(g.name), 'name')) continue;
    unmatchedGhl.push(g);
  }
  const fuzzyHits: Array<{ g: any; w: any }> = [];
  const stillUnmatchedGhl: any[] = [];
  for (const g of unmatchedGhl) {
    const cands = (byFuzzy.get(normFuzzy(g.name)) ?? []).filter((w) => !usedWix.has(w.id));
    if (cands.length === 1) { fuzzyHits.push({ g, w: cands[0] }); if (flag('fuzzy')) { pairs.push({ g, w: cands[0], via: 'fuzzy' }); usedWix.add(cands[0].id); } }
    else stillUnmatchedGhl.push(g);
  }
  const orphanWix = wix2.filter((w: any) => !usedWix.has(w.id));

  const bySlugN = pairs.filter((p) => p.via === 'slug').length;
  const byNameN = pairs.filter((p) => p.via === 'name').length;
  const byFuzzyN = pairs.filter((p) => p.via === 'fuzzy').length;
  console.log('=== MATCH REPORT ===');
  console.log(`  linked: ${pairs.length}  (slug ${bySlugN} · exact-name ${byNameN}${flag('fuzzy') ? ` · fuzzy ${byFuzzyN}` : ''})`);
  console.log(`  fuzzy candidates ${flag('fuzzy') ? '(auto-linked)' : '(NOT linked — re-run --fuzzy to accept)'}: ${flag('fuzzy') ? byFuzzyN : fuzzyHits.length}`);
  if (!flag('fuzzy') && fuzzyHits.length) for (const f of fuzzyHits.slice(0, 20)) console.log(`      GHL "${f.g.name}"  ≈  Wix "${f.w.name}"`);
  console.log(`  ambiguous (name collision, needs review): ${ambiguous.length}`);
  for (const a of ambiguous.slice(0, 20)) console.log(`      GHL "${a.g.name}" → ${a.n} Wix candidates`);
  console.log(`  GHL with NO Wix match: ${stillUnmatchedGhl.length}`);
  for (const g of stillUnmatchedGhl.slice(0, 30)) console.log(`      ${g.name}`);
  console.log(`  Wix with NO GHL match: ${orphanWix.length}`);
  for (const w of orphanWix.slice(0, 30)) console.log(`      ${w.name}`);

  const alreadyLinked = pairs.filter((p) => String(p.g.wixId) === String(p.w.id) && p.w.ghlId === p.g.id).length;
  console.log(`\n  (${alreadyLinked} pairs already fully linked both ways)`);

  if (stillUnmatchedGhl.length || orphanWix.length) {
    console.log('\n⚠️  Orphans exist — resolve (or accept --fuzzy) before a full apply so nothing is left unlinked.');
  }

  if (!flag('apply')) {
    console.log('\nDRY-RUN — no writes. On --apply: stamp ghlResourceId on each matched Wix row +');
    console.log('wix_resource_row_id on each matched GHL record (idempotent). --limit N to test a few first.');
    console.log('(--fuzzy also accepts the fuzzy candidates above.) Run resources-prep --apply first (columns).');
    process.exit(0);
  }

  // --- APPLY: stamp the link both ways (idempotent) ---
  const limit = process.argv.indexOf('--limit') >= 0 ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : undefined;
  const todo = limit ? pairs.slice(0, limit) : pairs;
  const { getCatalog } = await import('../lib/ghl/catalogCache');
  const { writeRecordFields } = await import('../lib/ghl/writeRecord');
  const { patchItem } = await import('../lib/wix/collections');
  const catalog = await getCatalog('custom_objects.resources', { force: true });

  console.log(`\n=== APPLY: stamping ${todo.length} pair(s)${limit ? ` (--limit ${limit})` : ''} ===`);
  let wixStamped = 0, ghlStamped = 0, errs = 0;
  for (const { g, w } of todo) {
    if (String(w.ghlId) !== String(g.id)) {
      try { await patchItem(WIX_RES, w.id, [{ fieldPath: 'ghlResourceId', value: g.id }]); wixStamped++; }
      catch (e: any) { errs++; console.log(`  ❌ Wix "${w.name}": ${e?.message ?? e}`); }
    }
    if (String(g.wixId) !== String(w.id)) {
      try {
        const r = await writeRecordFields('custom_objects.resources', g.id, { 'custom_objects.resources.wix_resource_row_id': w.id }, catalog);
        if (r.written.length) ghlStamped++; else console.log(`  ⚠️  GHL "${g.name}": nothing written (${JSON.stringify(r.skipped)})`);
      } catch (e: any) { errs++; console.log(`  ❌ GHL "${g.name}": ${e?.message ?? e}`); }
    }
  }
  console.log(`\nStamped: Wix ghlResourceId ×${wixStamped} · GHL wix_resource_row_id ×${ghlStamped} · errors ${errs}.`);
  console.log(limit ? 'Limited run — re-run without --limit for all 90.' : 'All pairs linked. Re-run (no --limit) is a no-op (idempotent).');
  process.exit(errs ? 1 : 0);
})().catch((e) => { console.error('LINK RECONCILE FAILED:', e?.stack ?? e); process.exit(2); });
