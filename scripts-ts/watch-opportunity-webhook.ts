// scripts-ts/watch-opportunity-webhook.ts — did the GHL opportunity-stage webhook actually fire?
//
// Shows the most recent activity writes attributed to the pipeline adapter. Run it right after
// moving an opportunity into a routed stage.
//
//   npx vite-node scripts-ts/watch-opportunity-webhook.ts [minutes]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const MINUTES = Number(process.argv[2] ?? 30);

(async () => {
  const { getDb } = await import('../lib/db');
  const { sql } = await import('drizzle-orm');
  const db = getDb();
  const since = new Date(Date.now() - MINUTES * 60000).toISOString();

  const rows: any = await db.execute(sql`
    SELECT ts, actor_name, action, record_label, record_id
    FROM change_log
    WHERE ts > ${since} AND actor_name LIKE 'activity:%'
    ORDER BY ts DESC LIMIT 25
  `);
  const list = rows.rows ?? rows;
  console.log(`activity writes in the last ${MINUTES} min: ${list.length}`);
  for (const r of list) console.log(`  ${new Date(r.ts).toLocaleTimeString()}  ${String(r.actor_name).padEnd(28)} ${r.action.padEnd(6)} ${r.record_label ?? r.record_id}`);

  const claims: any = await db.execute(sql`
    SELECT source, count(*)::int AS n, max(claimed_at) AS latest
    FROM activity_source_claims GROUP BY source ORDER BY n DESC
  `);
  console.log('\nidempotency claims by source:');
  for (const c of (claims.rows ?? claims)) {
    console.log(`  ${String(c.n).padStart(4)}  ${String(c.source).padEnd(18)} latest ${new Date(c.latest).toLocaleString()}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
