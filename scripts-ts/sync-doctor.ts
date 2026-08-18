// scripts-ts/sync-doctor.ts — audit every sync mapping for option-field hazards.
//
// Three failure classes we've hit:
//   • DROP  — an option present on one side but missing on the other → that value silently fails to
//             sync (e.g. Independent Validation "Other" missing on the company field).
//   • LOOP  — the two sides represent the same value differently (key vs label) with no transform, so
//             the sync keeps rewriting it and never converges (e.g. country "US" ⇄ "United States").
//   • CHURN — a field rewritten day after day with no source change, read from the change_log
//             (added 2026-08-17 after unguarded image/reference writes ran for weeks unnoticed).
// Run after editing mappings, or anytime, to catch these before they bite:
//   npx vite-node scripts-ts/sync-doctor.ts            (or: npm run sync:doctor)
//   npx vite-node scripts-ts/sync-doctor.ts --churn-days 14 --churn-min 2
// Reads .env.local; GHL_TARGET default live. Read-only.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';

const OPTION_TYPES = new Set(['SINGLE_OPTIONS', 'MULTIPLE_OPTIONS', 'RADIO']);
const UNWRITABLE = new Set(['CHECKBOX', 'TEXTBOX_LIST']);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '').replace(/[_-]+/g, '');

(async () => {
  const { DbMappingStore } = await import('../lib/mapping/dbStore');
  const { getCatalog } = await import('../lib/ghl/catalogCache');
  const store = new DbMappingStore();
  const syncs = (await store.listSyncs()) as any[];

  const catalogCache = new Map<string, any>();
  const cat = async (obj: string) => { if (!catalogCache.has(obj)) catalogCache.set(obj, await getCatalog(obj)); return catalogCache.get(obj); };

  const findings: { level: string; conn: string; msg: string }[] = [];
  const add = (level: string, conn: string, msg: string) => findings.push({ level, conn, msg });

  for (const s of syncs) {
    const meta = await store.getSyncMeta(s.slug);
    if (!meta) continue;
    const srcCat = await cat(meta.sourceObject);
    const tgtCat = await cat(meta.destObject);
    const set = await store.loadSync(s.slug);
    for (const m of set.mappings as any[]) {
      if (m.enabled === false) continue;
      const sourceKey = m.contactKey, targetKey = m.businessKey; // generic engine: contactKey=source, businessKey=target
      const srcDef = srcCat.byKey[sourceKey];
      const tgtDef = tgtCat.byKey[targetKey];
      const srcOpts = (srcDef?.options ?? []) as { key: string; label: string }[];
      const tgtOpts = (tgtDef?.options ?? []) as { key: string; label: string }[];
      const srcIsOpt = srcDef && OPTION_TYPES.has(srcDef.dataType);
      const tgtIsOpt = tgtDef && OPTION_TYPES.has(tgtDef.dataType);
      const pair = `${sourceKey} → ${targetKey}`;

      // Target type can't be written via API at all.
      if (tgtDef && UNWRITABLE.has(tgtDef.dataType)) { add('🟡 TYPE', s.slug, `${pair} — target is ${tgtDef.dataType} (not API-writable)`); continue; }

      // DROP: option on source with no matching option (by label or key) on the target.
      if (srcIsOpt && tgtIsOpt) {
        const tgtSet = new Set(tgtOpts.flatMap((o) => [norm(o.label), norm(o.key)]));
        const missing = srcOpts.filter((o) => !tgtSet.has(norm(o.label)) && !tgtSet.has(norm(o.key)));
        if (missing.length) add('🟠 DROP', s.slug, `${pair} — source options not on target (will drop): ${missing.map((o) => o.label).join(', ')}`);
      }

      // LOOP: one side is an option field, the other is a plain scalar/text/number, and no transform —
      // if the option's key ≠ label, the value round-trips (key→label→…) and never converges.
      const optSide = srcIsOpt ? srcDef : tgtIsOpt ? tgtDef : null;
      const otherIsPlain = srcIsOpt ? !tgtIsOpt : tgtIsOpt ? !srcIsOpt : false;
      if (optSide && otherIsPlain && !m.transform) {
        const keyLabelDrift = (optSide.options ?? []).some((o: any) => norm(o.key) !== norm(o.label));
        if (keyLabelDrift) add('🔴 LOOP', s.slug, `${pair} — option field ↔ plain field, no transform, and option key≠label → non-converging (add a transform)`);
      }
      if (m.transform) add('✓ GUARDED', s.slug, `${pair} — transform=${m.transform}`);
    }
  }

  const order = ['🔴 LOOP', '🟠 DROP', '🟡 TYPE', '✓ GUARDED'];
  findings.sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
  console.log(`Sync doctor — ${syncs.length} connections scanned.\n`);
  if (!findings.length) {
    console.log('No option-field hazards found. ✅');
  } else {
    let last = '';
    for (const f of findings) { if (f.level !== last) { console.log(`\n${f.level}`); last = f.level; } console.log(`  [${f.conn}] ${f.msg}`); }
    const loops = findings.filter((f) => f.level.includes('LOOP')).length;
    const drops = findings.filter((f) => f.level.includes('DROP')).length;
    console.log(`\nSummary: ${loops} loop-risk, ${drops} drop-risk. Fix loop-risks before enabling real-time sync.`);
  }

  await reportChurn();
  process.exit(0);
})().catch((e) => { console.error('SYNC DOCTOR FAILED:', e?.stack ?? e); process.exit(1); });

/**
 * CHURN — the third failure class, added 2026-08-17.
 *
 * A converged sync rewrites a field only when its source changes. So the same (record, field)
 * appearing in many applied writes over a window is proof of a non-converging write path, even when
 * every individual write looks legitimate. This is what would have caught the unguarded image and
 * reference intents in July instead of August: `image_fld`, `companyLogo`, `program` and
 * `collectives` were rewritten for the same handful of contacts every single day (126 image writes
 * and 269 reference replaces in 13 days), each image write a fresh Media Manager upload.
 *
 * Reads the change_log only — no API calls, safe to run any time.
 *   --churn-days N   window to scan (default 7)
 *   --churn-min N    flag a field rewritten on N+ distinct days (default 3)
 */
async function reportChurn() {
  const argNum = (name: string, dflt: number) => {
    const i = process.argv.indexOf(`--${name}`);
    const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  const days = argNum('churn-days', 7);
  const minDays = argNum('churn-min', 3);

  const { hasDatabase } = await import('../lib/db');
  if (!hasDatabase) {
    console.log('\nCHURN — skipped (no DATABASE_URL).');
    return;
  }
  const { queryChangeLog } = await import('../lib/audit/query');

  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  // Page through the window (queryChangeLog caps at 500 per call).
  const rows: any[] = [];
  for (let offset = 0; offset < 10_000; offset += 500) {
    const page = await queryChangeLog({ since, applied: 'applied', limit: 500, offset });
    rows.push(...page.rows);
    if (!page.hasMore) break;
  }

  // (objectType|recordId|field) -> the distinct days it was written on.
  const seen = new Map<string, Set<string>>();
  const labels = new Map<string, string>();
  for (const r of rows) {
    const day = new Date(r.ts).toISOString().slice(0, 10);
    for (const c of (r.changes ?? []) as Array<{ field?: string }>) {
      if (!c?.field) continue;
      const key = `${r.objectType}|${r.recordId}|${c.field}`;
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key)!.add(day);
      if (r.recordLabel) labels.set(key, String(r.recordLabel));
    }
  }

  const churning = Array.from(seen.entries())
    .map(([key, daySet]) => ({ key, days: daySet.size }))
    .filter((x) => x.days >= minDays)
    .sort((a, b) => b.days - a.days);

  console.log(`\n\nCHURN — applied writes over the last ${days} day(s): ${rows.length} events scanned.`);
  if (!churning.length) {
    console.log(`No field was rewritten on ${minDays}+ separate days. Syncs are converging. ✅`);
    return;
  }
  console.log(`🔴 ${churning.length} (record, field) pair(s) rewritten on ${minDays}+ separate days —`);
  console.log('   a converged sync writes only when its source changes, so these are non-converging:\n');
  for (const c of churning.slice(0, 25)) {
    const [objectType, recordId, field] = c.key.split('|');
    const label = labels.get(c.key);
    console.log(`  ${String(c.days).padStart(2)} days · ${field}  (${objectType} ${label ? `"${label}" ` : ''}${recordId})`);
  }
  if (churning.length > 25) console.log(`  … and ${churning.length - 25} more`);
  console.log('\nUsual causes: an unguarded write intent (image/reference), a value GHL stores in a');
  console.log('different form than we send it, or free-text AI output that should be a derived field.');
}
