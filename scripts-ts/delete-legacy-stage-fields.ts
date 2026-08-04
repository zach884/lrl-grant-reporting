// scripts-ts/delete-legacy-stage-fields.ts — delete legacy Client-Stage scoring fields from the
// business + contact objects (Zach sign-off 2026-08-04, review groups A+B+C). IRREVERSIBLE: drops the
// field definition and its stored values on every record. Keeps date_of_initial_intake (not a scoring
// artifact). See memory/project_stage_scorer.md.
//
//   npx vite-node scripts-ts/delete-legacy-stage-fields.ts                 # DRY-RUN (lists targets)
//   npx vite-node scripts-ts/delete-legacy-stage-fields.ts --only trl_initial   # limit to key(s)
//   npx vite-node scripts-ts/delete-legacy-stage-fields.ts --apply --yes   # DELETE (irreversible!)
//
// Reads .env.local; target via GHL_TARGET (default live). Idempotent — a key already gone is skipped.

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
const flag = (n: string) => process.argv.includes(`--${n}`);
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };

// The legacy keys to delete (bare, on BOTH business + contact). date_of_initial_intake is intentionally
// NOT here — it's a real intake date, not a scoring artifact.
const LEGACY_KEYS = [
  // C: initial baseline (Zach: delete now, accept baseline loss)
  'trl_initial', 'mrl_initial', 'crl_initial', 'churchill_initial', 'churchill_substage_initial',
  // A: advancement deltas + rollup + assessment method
  'trl_advancement', 'mrl_advancement', 'crl_advancement', 'churchill_advancement',
  'total_business_stage_advancement', 'initial_assessment_method', 'business_stage_rescored_method',
  // B: superseded by the stage record (rescore_date) + combined rationale
  'business_stage_rescored_date', 'latest_churchill_stage_rationale',
];

(async () => {
  loadEnvLocal();
  if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';
  const apply = flag('apply');
  if (apply && !flag('yes')) {
    console.error('Refusing to DELETE without --yes. This PERMANENTLY removes fields + their data. Re-run with --apply --yes.');
    process.exit(1);
  }
  const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);
  const keys = only ? LEGACY_KEYS.filter((k) => only.includes(k)) : LEGACY_KEYS;

  const { getBusinessFieldCatalog, getContactFieldCatalog, deleteObjectField, deleteLocationField } =
    await import('../lib/ghl/customFields');

  const [biz, con] = await Promise.all([getBusinessFieldCatalog(), getContactFieldCatalog()]);
  const pick = (cat: any, k: string) => cat.fields.find((f: any) => f.fieldKey.endsWith('.' + k) || f.fieldKey === k);

  type Target = { object: 'business' | 'contact'; key: string; id: string; name: string; del: (id: string) => Promise<void> };
  const targets: Target[] = [];
  for (const k of keys) {
    const b = pick(biz, k); if (b) targets.push({ object: 'business', key: k, id: b.id, name: b.name, del: deleteObjectField });
    const c = pick(con, k); if (c) targets.push({ object: 'contact', key: k, id: c.id, name: c.name, del: deleteLocationField });
  }

  console.log(`Delete legacy stage fields (${apply ? 'APPLY — IRREVERSIBLE' : 'DRY-RUN'}, target=${process.env.GHL_TARGET})`);
  console.log(`Keys: ${keys.length}  |  fields resolved: ${targets.length}  |  (date_of_initial_intake is KEPT)\n`);
  for (const t of targets) console.log(`  ${t.object.padEnd(8)} ${t.key.padEnd(34)} id=${t.id}  "${t.name}"`);
  if (!apply) { console.log(`\nDRY-RUN only. Re-run with --apply --yes to permanently delete these ${targets.length} field(s).`); process.exit(0); }

  console.log('\nDeleting…');
  let ok = 0, fail = 0;
  for (const t of targets) {
    try { await t.del(t.id); ok++; console.log(`  ✓ deleted ${t.object}.${t.key}`); }
    catch (e: any) { fail++; console.error(`  ✗ FAILED ${t.object}.${t.key}: ${e?.status ?? ''} ${e?.body?.message ?? e?.message ?? e}`); }
  }
  console.log(`\nDone: ${ok} deleted, ${fail} failed.`);
  process.exit(fail ? 2 : 0);
})();
