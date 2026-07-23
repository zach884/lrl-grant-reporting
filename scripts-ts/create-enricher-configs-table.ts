// scripts-ts/create-enricher-configs-table.ts — create the additive enricher_configs table.
//
//   npx vite-node scripts-ts/create-enricher-configs-table.ts
//
// `drizzle-kit push` can't run here (it prompts create-vs-rename and needs a TTY). This applies the
// exact table + unique index that lib/db/schema.ts declares, idempotently (IF NOT EXISTS), so it's
// safe to re-run and safe on prod (purely additive; touches no existing table). Reads .env.local.

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
    CREATE TABLE IF NOT EXISTS enricher_configs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enricher text NOT NULL,
      source_object text NOT NULL DEFAULT 'contact',
      enabled boolean NOT NULL DEFAULT true,
      gate jsonb,
      membership jsonb,
      version integer NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS enricher_configs_enricher_source_uq
      ON enricher_configs (enricher, source_object)
  `);

  const rows = await db.execute(sql`SELECT count(*)::int AS n FROM enricher_configs`);
  console.log('✅ enricher_configs ready. Existing rows:', (rows as any).rows?.[0]?.n ?? (rows as any)[0]?.n ?? 0);
  process.exit(0);
})().catch((e) => { console.error('CREATE TABLE FAILED:', e?.stack ?? e); process.exit(2); });
