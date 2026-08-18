// scripts-ts/add-wix-row-value-map.ts — add wix_mapping_rows.value_map (per-row label rewrites).
//
//   npx vite-node scripts-ts/add-wix-row-value-map.ts
//
// `drizzle-kit push` can't run here (it prompts create-vs-rename and needs a TTY). This applies the
// one column lib/db/schema.ts declares, idempotently. Purely ADDITIVE and nullable: existing rows
// read as "no valueMap" and behave exactly as before, so it is safe on prod and safe to re-run.
//
// Why the column exists: a few GHL option labels are a genuinely different NAME in Wix
// ("i4.0 Accelerator" vs "Industry 4.0 Accelerator"). Casing/whitespace is handled by the reference
// resolver; this covers the rest, which were otherwise silently dropped from the reference set.

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

(async () => {
  loadEnvLocal();
  const { getDb } = await import('../lib/db');
  const { sql } = await import('drizzle-orm');
  const db = getDb();

  await db.execute(sql`ALTER TABLE wix_mapping_rows ADD COLUMN IF NOT EXISTS value_map jsonb`);

  const res: any = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'wix_mapping_rows' AND column_name = 'value_map'
  `);
  const row = res.rows?.[0] ?? res[0];
  if (!row) { console.error('❌ value_map column not present after ALTER'); process.exit(1); }
  console.log(`✅ wix_mapping_rows.value_map ready (${row.data_type}, nullable=${row.is_nullable})`);

  const cnt: any = await db.execute(sql`SELECT count(*)::int AS n FROM wix_mapping_rows WHERE value_map IS NOT NULL`);
  console.log(`   rows with a valueMap: ${cnt.rows?.[0]?.n ?? cnt[0]?.n ?? 0}`);
  process.exit(0);
})().catch((e) => { console.error('ADD COLUMN FAILED:', e?.stack ?? e); process.exit(2); });
