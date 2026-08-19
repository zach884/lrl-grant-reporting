// scripts-ts/backfill-change-log-labels.ts — fill in record_label for change_log rows logged before
// labels existed, so the existing history is readable too.
//
//   npx vite-node scripts-ts/backfill-change-log-labels.ts                 # DRY-RUN
//   npx vite-node scripts-ts/backfill-change-log-labels.ts --apply --yes   # write
//   npx vite-node scripts-ts/backfill-change-log-labels.ts --days 30       # window (default 30)
//
// Only touches rows where record_label IS NULL or is just the record id repeated. Resolution is
// memoised per record, so a few hundred rows cost a handful of GHL reads. Rows whose record has
// since been deleted keep a null label — that is honest, and better than inventing one.
//
// Wix rows (objectType `wix:<set>`) are left alone: their id is a Wix item id, not a GHL record, so
// there is nothing to look up. New Wix events get a label at write time from the source record.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';
const flag = (n: string) => process.argv.includes(`--${n}`);
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };

(async () => {
  const apply = flag('apply');
  if (apply && !flag('yes')) { console.error('Refusing to APPLY without --yes.'); process.exit(1); }
  const days = Number(arg('days') ?? 30);

  const { getDb, hasDatabase } = await import('../lib/db');
  if (!hasDatabase) { console.error('No DATABASE_URL.'); process.exit(1); }
  const { sql, inArray, eq } = await import('drizzle-orm');
  const { changeLog } = await import('../lib/db/schema');
  const { resolveRecordLabel } = await import('../lib/audit/label');
  const db = getDb();

  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const res: any = await db.execute(sql`
    SELECT id, object_type, record_id, record_label
    FROM change_log
    WHERE ts >= ${since}
      AND object_type NOT LIKE 'wix:%'
      AND record_id IS NOT NULL AND record_id <> ''
      AND (record_label IS NULL OR record_label = '' OR record_label = record_id)
    ORDER BY ts DESC
  `);
  const rows: any[] = res.rows ?? res;
  console.log(`rows needing a label in the last ${days} day(s): ${rows.length}`);
  if (!rows.length) { console.log('Nothing to do.'); process.exit(0); }

  const byRecord = new Map<string, string[]>();
  for (const r of rows) {
    const k = `${r.object_type}|${r.record_id}`;
    if (!byRecord.has(k)) byRecord.set(k, []);
    byRecord.get(k)!.push(r.id);
  }
  console.log(`distinct records to resolve: ${byRecord.size}`);

  let labelled = 0, unresolved = 0, updated = 0;
  for (const [k, ids] of Array.from(byRecord.entries())) {
    const [objectType, recordId] = k.split('|');
    const label = await resolveRecordLabel(objectType, recordId);
    if (!label) { unresolved++; continue; }
    labelled++;
    console.log(`  ${objectType.padEnd(30)} ${recordId}  →  "${label}"  (${ids.length} row(s))`);
    if (!apply) continue;
    // `id = ANY($1)` binds the array as one scalar param over the Neon HTTP driver; use the ORM's
    // typed inArray instead (and chunk, since a long id list can blow the parameter limit).
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      await db.update(changeLog).set({ recordLabel: label }).where(inArray(changeLog.id, batch));
      updated += batch.length;
    }
  }

  console.log(`\nresolved ${labelled} record(s) · unresolved ${unresolved} (deleted or unnamed — left null)`);
  console.log(apply ? `✅ updated ${updated} change_log row(s).` : '\nDRY-RUN — re-run with --apply --yes.');
  process.exit(0);
})().catch((e) => { console.error('BACKFILL FAILED:', e?.stack ?? e); process.exit(2); });
