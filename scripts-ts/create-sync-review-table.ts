// scripts-ts/create-sync-review-table.ts — create the sync_review table.
//
//   npx vite-node scripts-ts/create-sync-review-table.ts
//
// Additive and idempotent (IF NOT EXISTS), safe to re-run and safe on prod — same approach as
// create-activity-claims-table.ts, because `drizzle-kit push` needs a TTY and prompts
// create-vs-rename. See lib/db/schema.ts for what the queue is for.
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
    CREATE TABLE IF NOT EXISTS sync_review (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ts timestamptz NOT NULL DEFAULT now(),
      kind text NOT NULL,
      object_type text NOT NULL,
      record_id text NOT NULL,
      record_label text,
      subject_type text,
      subject_id text,
      subject_label text,
      reason text NOT NULL,
      detail jsonb,
      seen_count integer NOT NULL DEFAULT 1,
      resolved_at timestamptz,
      resolved_note text
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS sync_review_open_uq
      ON sync_review (kind, record_id, subject_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS sync_review_ts_idx ON sync_review (ts)
  `);
  const r: any = await db.execute(sql`SELECT count(*) AS n FROM sync_review`);
  console.log('sync_review ready — rows:', ((r as any).rows ?? r)[0].n);
})().catch((e) => { console.error(e); process.exit(1); });
