// scripts-ts/dump-mappings.ts — snapshot the LIVE Postgres mappings to config/field-mappings.json.
//
//   npm run db:dump
//
// Postgres is the source of truth (edited at /mappings). This writes a git-trackable snapshot
// of the current DB state to the committed JSON — for history/audit, disaster recovery, and
// re-seeding a fresh DB. The JSON is NOT authoritative; run this whenever you want the file to
// reflect the DB. Requires DATABASE_URL (or POSTGRES_URL) in .env.local.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DbMappingStore, DEFAULT_SYNC_SLUG } from '../lib/mapping/dbStore';

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
  if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL) {
    console.error('No DB connection. Set DATABASE_URL (or POSTGRES_URL) in .env.local.');
    process.exit(1);
  }
  const set = await new DbMappingStore().loadSync(DEFAULT_SYNC_SLUG);
  const out = {
    _note: 'SNAPSHOT of the live Postgres mappings (source of truth = DB, edited at /mappings). Regenerate with `npm run db:dump`. Not read at runtime when DATABASE_URL is set.',
    version: set.version,
    updatedAt: set.updatedAt,
    mappings: set.mappings,
  };
  const file = join(process.cwd(), 'config', 'field-mappings.json');
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`Wrote snapshot: v${set.version}, ${set.mappings.length} mappings -> config/field-mappings.json`);
  process.exit(0);
})().catch((e) => { console.error('DUMP FAILED:', e?.stack ?? e); process.exit(2); });
