// scripts-ts/ai-field-rename-plan.ts — list (and optionally apply) an "[AI] " prefix on every GHL
// field the app writes automatically, so staff can tell at a glance which fields not to hand-edit.
//
//   npx vite-node scripts-ts/ai-field-rename-plan.ts                 # LIST ONLY (default)
//   npx vite-node scripts-ts/ai-field-rename-plan.ts --apply --yes   # rename them
//   npx vite-node scripts-ts/ai-field-rename-plan.ts --revert --yes  # strip the prefix again
//
// Sources are derived from CODE/CONFIG, not hand-listed: each enricher's own `produces` array, the
// stage scorer's written props, the DB-configured score-propagation connection's targets, and each
// Wix mapping set's `writebackField`.
//
// TWO prefixes, because the distinction matters to whoever reads the field:
//   [AI]   — a value the app INFERRED (enricher / AI scorer). Editing it by hand gets overwritten.
//   [SYNC] — a machine-maintained pointer (the Wix row id written back after a sync). Never hand-edit.
// GHL→GHL mirrored fields are deliberately NOT prefixed: they're copied, not inferred, and Zach wants
// them to keep reading as ordinary fields.
//
// Renaming only changes the display label — GHL preserves fieldKey, so mappings/syncs are unaffected.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';
const flag = (n: string) => process.argv.includes(`--${n}`);

const AI_PREFIX = '[AI] ';
const SYNC_PREFIX = '[SYNC] ';
const ANY_PREFIX = /^\[(AI|SYNC)\]\s*/;

(async () => {
  const apply = flag('apply');
  const revert = flag('revert');
  if ((apply || revert) && !flag('yes')) { console.error('Refusing to write without --yes.'); process.exit(1); }

  const { countyEnricher } = await import('../lib/enrichment/enrichers/county').catch(() => ({} as any));
  const mods = await Promise.all([
    import('../lib/enrichment/enrichers/county'),
    import('../lib/enrichment/enrichers/geoZone'),
    import('../lib/enrichment/enrichers/laraId'),
    import('../lib/enrichment/enrichers/naics'),
    import('../lib/enrichment/enrichers/readinessTagger'),
    import('../lib/enrichment/enrichers/resourceTagger'),
  ]);

  // Every exported object that looks like an enricher (has name + produces).
  type Src = { key: string; writer: string; prefix?: string };
  const sources: Src[] = [];
  for (const m of mods as any[]) {
    for (const v of Object.values(m)) {
      const e: any = v;
      if (e && typeof e === 'object' && Array.isArray(e.produces) && typeof e.name === 'string') {
        for (const k of e.produces) sources.push({ key: k, writer: `enricher:${e.name}` });
      }
    }
  }

  // Stage scorer (writes onto custom_objects.business_stage).
  const { STAGE_OBJECT } = await import('../lib/stage/priorAssessment');
  for (const bare of ['trl','mrl','crl','churchill_score','churchill_substage','stage_rationale','rescore_method','snapshot_kind']) {
    sources.push({ key: `${STAGE_OBJECT}.${bare}`, writer: 'scorer:client-stage-scorer' });
  }

  // Score propagation → company *_current fields (DB-configured, so read the connection).
  let propagationRead = false;
  try {
    const { loadPushConnection } = await import('../lib/sync/orchestrate');
    const { CURRENT_SCORING_SLUG } = await import('../lib/stage/propagateScoring');
    const conn: any = await loadPushConnection(CURRENT_SCORING_SLUG);
    if (conn) {
      propagationRead = true;
      for (const r of conn.rows ?? []) {
        if (r.enabled === false) continue;
        const t = r.targetKey ?? r.targetFieldKey ?? r.businessKey ?? r.target;
        if (t) sources.push({ key: String(t), writer: `sync:${CURRENT_SCORING_SLUG}` });
      }
    } else {
      console.log(`(note: the ${CURRENT_SCORING_SLUG} connection is not configured — no *_current company fields to list)`);
    }
  } catch (e: any) {
    console.log(`(⚠️ could not read the score-propagation connection — the company *_current fields may be MISSING from this list: ${e?.message ?? e})`);
  }
  if (!propagationRead) console.log('(⚠️ score-propagation targets unread — see note above)');

  // [SYNC] — the Wix row-id write-back pointers, read from each mapping set's own writebackField.
  try {
    const { getWixStore } = await import('../lib/mapping/wixStore');
    const store = getWixStore();
    const summaries = await store.listSets();
    for (const sm of summaries) {
      const set = await store.getSet(sm.id);
      if (set?.writebackField) sources.push({ key: set.writebackField, writer: `wix-writeback:${set.name}`, prefix: SYNC_PREFIX });
    }
  } catch (e: any) {
    console.log(`(⚠️ could not read Wix mapping sets — write-back fields may be MISSING: ${e?.message ?? e})`);
  }

  // Resolve against the live catalogs.
  const { getCatalog } = await import('../lib/ghl/catalogCache');
  const objects = Array.from(new Set(sources.map(s => s.key.split('.').slice(0, s.key.startsWith('custom_objects.') ? 2 : 1).join('.'))));
  const cats: Record<string, any> = {};
  for (const o of objects) { try { cats[o] = await getCatalog(o, { force: true }); } catch { /* skip */ } }

  const byKey = new Map<string, { writers: Set<string>; prefix: string }>();
  for (const s of sources) {
    if (!byKey.has(s.key)) byKey.set(s.key, { writers: new Set(), prefix: s.prefix ?? AI_PREFIX });
    const e = byKey.get(s.key)!;
    e.writers.add(s.writer);
    // A field claimed by both an inference and a write-back would be ambiguous; inference wins.
    if (!s.prefix) e.prefix = AI_PREFIX;
  }

  const rows: any[] = [];
  for (const [key, meta] of Array.from(byKey.entries())) {
    const obj = key.startsWith('custom_objects.') ? key.split('.').slice(0,2).join('.') : key.split('.')[0];
    const cat = cats[obj];
    const def = cat?.byKey?.[key];
    const folder = def?.parentId ? (cat.folders ?? []).find((f: any) => f.id === def.parentId)?.name : undefined;
    const bare = def?.name ? String(def.name).replace(ANY_PREFIX, '') : undefined;
    rows.push({
      object: obj, key, id: def?.id, dataType: def?.dataType,
      name: def?.name, folder, writers: Array.from(meta.writers).join(', '),
      prefix: meta.prefix,
      exists: !!def,
      alreadyPrefixed: def?.name === (bare ? meta.prefix + bare : undefined),
      proposed: bare ? meta.prefix + bare : undefined,
      optionCount: (def?.options ?? []).length,
    });
  }
  rows.sort((a, b) => (a.object + (a.folder ?? '') + (a.name ?? '')).localeCompare(b.object + (b.folder ?? '') + (b.name ?? '')));

  let lastGroup = '';
  for (const r of rows) {
    const g = `${r.object}   ·   folder: ${r.folder ?? '(none)'}`;
    if (g !== lastGroup) { console.log(`\n■ ${g}`); lastGroup = g; }
    if (!r.exists) { console.log(`   ⚠️  ${r.key}  — NOT IN LIVE CATALOG (code writes it but the field is missing)`); continue; }
    const arrow = r.alreadyPrefixed ? '(already prefixed)' : `→  "${r.proposed}"`;
    console.log(`   "${r.name}"  ${arrow}`);
    console.log(`        ${r.key}  [${r.dataType}]  written by ${r.writers}`);
  }

  const todo = rows.filter(r => r.exists && !r.alreadyPrefixed);
  console.log(`\n─────────────────────────────────────────────`);
  console.log(`${rows.length} field(s) written automatically · ${todo.length} would be renamed · ${rows.filter(r=>!r.exists).length} missing from the catalog`);
  mkdirSync('reports', { recursive: true });
  writeFileSync('reports/ai-field-rename-plan.json', JSON.stringify(rows, null, 2));
  console.log('plan → reports/ai-field-rename-plan.json');

  if (!apply && !revert) { console.log('\nLIST ONLY — re-run with --apply --yes to rename, or --revert --yes to strip the prefix.'); process.exit(0); }

  const { ghl } = await import('../lib/ghl/client');
  const { updateObjectFieldName, updateLocationFieldName } = await import('../lib/ghl/customFields');
  const c = ghl();

  // CANARY — the object-field rename endpoint (PUT /custom-fields/{id}) is not documented to preserve
  // an option list. Prove it on ONE options-bearing object field before touching the other 24.
  if (apply && !flag('skip-canary')) {
    const canary = rows.find(r => r.exists && !r.alreadyPrefixed && r.object !== 'contact' && r.optionCount > 0);
    if (canary) {
      console.log(`\n── CANARY: ${canary.key} ("${canary.name}", ${canary.optionCount} options) ──`);
      await updateObjectFieldName(canary.id, canary.proposed, c);
      const cat2: any = await getCatalog(canary.object, { force: true });
      const after = cat2.byKey[canary.key];
      const okOpts = (after?.options ?? []).length === canary.optionCount;
      console.log(`   name → "${after?.name}"  |  options ${canary.optionCount} → ${(after?.options ?? []).length}  ${okOpts ? '✅ preserved' : '❌ LOST'}`);
      if (!okOpts) {
        console.error('\nABORTING: the rename dropped the option list. Restoring the original name and stopping.');
        await updateObjectFieldName(canary.id, String(canary.name), c);
        process.exit(1);
      }
      canary.alreadyPrefixed = true; // already done
      console.log('   canary passed — continuing with the rest.\n');
    }
  }

  let ok = 0, failed = 0;
  for (const r of rows) {
    if (!r.exists) continue;
    const target = revert ? String(r.name).replace(ANY_PREFIX, '') : r.proposed;
    if (target === r.name) continue;
    try {
      if (r.object === 'contact' || r.object === 'opportunity') await updateLocationFieldName(r.id, target, c);
      else await updateObjectFieldName(r.id, target, c);
      console.log(`  ✅ ${r.key}  "${r.name}" → "${target}"`);
      ok++;
    } catch (e: any) {
      console.log(`  ❌ ${r.key}: ${String(e?.message ?? e).slice(0, 160)}`);
      failed++;
    }
  }
  console.log(`\n${ok} renamed · ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('RENAME PLAN FAILED:', e?.stack ?? e); process.exit(2); });
