// scripts-ts/enable-current-scoring.ts — enable the "company-current-scoring" sync's mappings.
//
// The company-current-scoring push connection (business_stage → business) maps the stage record's
// scores to the company's *_current fields, but its rows shipped disabled (enabled=false), so the
// sync no-ops. The scorer now propagates through this connection after each score write; this script
// flips those rows on so propagation actually writes. Idempotent — re-running is a no-op.
//
//   npx vite-node scripts-ts/enable-current-scoring.ts          # DRY-RUN (prints what would change)
//   npx vite-node scripts-ts/enable-current-scoring.ts --apply  # write enabled=true
//
// Reads .env.local automatically. DB-only (no GHL writes); target-agnostic.

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
const SLUG = 'company-current-scoring';

(async () => {
  loadEnvLocal();
  const apply = flag('apply');
  const { getDbStore } = await import('../lib/mapping/store');
  const store = getDbStore();

  const set = await store.loadSync(SLUG);
  if (!set.mappings.length) {
    console.error(`No mappings found for sync "${SLUG}".`);
    process.exit(1);
  }
  const disabled = set.mappings.filter((m) => m.enabled === false);
  console.log(`Sync "${SLUG}": ${set.mappings.length} mappings, ${disabled.length} disabled.`);
  for (const m of set.mappings) {
    console.log(`  [${m.enabled === false ? 'OFF' : 'on '}] ${m.contactKey} -> ${m.businessKey}`);
  }
  if (!disabled.length) {
    console.log('\nAll mappings already enabled — nothing to do.');
    process.exit(0);
  }
  if (!apply) {
    console.log(`\nDRY-RUN: would enable ${disabled.length} mapping(s). Re-run with --apply to write.`);
    process.exit(0);
  }
  const next = set.mappings.map((m) => ({ ...m, enabled: true }));
  await store.saveSync(SLUG, next);
  store.invalidate(SLUG);
  console.log(`\nAPPLIED: enabled ${disabled.length} mapping(s) on "${SLUG}".`);
  process.exit(0);
})();
