// scripts-ts/create-activity-routes-table.ts — create the activity_routes table.
//
//   npx vite-node scripts-ts/create-activity-routes-table.ts
//
// Additive and idempotent (IF NOT EXISTS); safe to re-run and safe on prod. Same approach as
// create-enricher-configs-table.ts (drizzle-kit push needs a TTY).

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

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS activity_routes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source text NOT NULL,
      match_kind text NOT NULL,
      match_id text NOT NULL,
      match_label text,
      activity_type text NOT NULL,
      program jsonb,
      defaults jsonb,
      enabled boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS activity_routes_uq
      ON activity_routes (source, match_kind, match_id)
  `);

  const rows: any = await db.execute(sql`SELECT count(*)::int AS n FROM activity_routes`);
  console.log('✅ activity_routes ready. Existing rows:', rows.rows?.[0]?.n ?? rows[0]?.n ?? 0);
  process.exit(0);
})().catch((e) => { console.error('CREATE TABLE FAILED:', e?.stack ?? e); process.exit(2); });
