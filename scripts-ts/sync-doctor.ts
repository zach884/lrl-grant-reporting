// scripts-ts/sync-doctor.ts — audit every sync mapping for option-field hazards.
//
// Two failure classes we've hit:
//   • DROP  — an option present on one side but missing on the other → that value silently fails to
//             sync (e.g. Independent Validation "Other" missing on the company field).
//   • LOOP  — the two sides represent the same value differently (key vs label) with no transform, so
//             the sync keeps rewriting it and never converges (e.g. country "US" ⇄ "United States").
// Run after editing mappings, or anytime, to catch these before they bite:
//   npx vite-node scripts-ts/sync-doctor.ts            (or: npm run sync:doctor)
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
  if (!findings.length) { console.log('No option-field hazards found. ✅'); process.exit(0); }
  let last = '';
  for (const f of findings) { if (f.level !== last) { console.log(`\n${f.level}`); last = f.level; } console.log(`  [${f.conn}] ${f.msg}`); }
  const loops = findings.filter((f) => f.level.includes('LOOP')).length;
  const drops = findings.filter((f) => f.level.includes('DROP')).length;
  console.log(`\nSummary: ${loops} loop-risk, ${drops} drop-risk. Fix loop-risks before enabling real-time sync.`);
  process.exit(0);
})().catch((e) => { console.error('SYNC DOCTOR FAILED:', e?.stack ?? e); process.exit(1); });
