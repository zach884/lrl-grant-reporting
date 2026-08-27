// scripts-ts/add-ledger-recent-column.ts — add sync_write_ledger.recent, and clear the rows whose
// value never landed.
//
//   npx vite-node scripts-ts/add-ledger-recent-column.ts
//
// Additive and idempotent. Two changes:
//
//  1. `recent` (jsonb) holds the last few values written per (record, field), which is what makes
//     A→B→A oscillation detectable — see lib/db/schema.ts and lib/sync/convergenceGuard.ts.
//
//  2. Deletes ledger rows with an empty `last_value`. Those are the residue of the key-shape bug
//     fixed in lib/ghl/writeRecord.ts: object-record writes reported BARE keys while the caller keyed
//     its values by the prefixed key, so every company-side row stored '' under the wrong key. An
//     empty value is functionally identical to no row at all (the guard's equality can never match
//     it), so deleting is safe and stops the bad key shape from lingering. Correct rows are rewritten
//     by the next sync.
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

  await db.execute(sql`ALTER TABLE sync_write_ledger ADD COLUMN IF NOT EXISTS recent jsonb`);

  const before: any = await db.execute(sql`
    SELECT count(*) AS total, count(*) FILTER (WHERE last_value = '' OR last_value IS NULL) AS empty
    FROM sync_write_ledger`);
  const b = ((before as any).rows ?? before)[0];
  console.log(`ledger before: ${b.total} rows, ${b.empty} with an empty value`);

  await db.execute(sql`DELETE FROM sync_write_ledger WHERE last_value = '' OR last_value IS NULL`);

  const after: any = await db.execute(sql`SELECT count(*) AS total FROM sync_write_ledger`);
  console.log(`ledger after:  ${((after as any).rows ?? after)[0].total} rows, recent column ready`);
})().catch((e) => { console.error(e); process.exit(1); });
