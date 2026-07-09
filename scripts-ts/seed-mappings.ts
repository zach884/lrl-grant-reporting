// scripts-ts/seed-mappings.ts — load config/field-mappings.json into Postgres.
//
//   npx vite-node scripts-ts/seed-mappings.ts
//
// Idempotent: ensures the "contact-company" sync row exists, then replaces its
// field_mappings with the rows from the committed JSON (the seed artifact). Run once after
// `drizzle-kit push`, and any time you want to reset prod mappings back to the file.
// Requires POSTGRES_URL (read from .env.local automatically).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { syncs, fieldMappings, type NewFieldMappingRow } from '../lib/db/schema';
import type { MappingSet } from '../lib/mapping/types';
import { DEFAULT_SYNC_SLUG } from '../lib/mapping/dbStore';

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
    console.error('No DB connection. Attach Vercel Postgres/Neon and add POSTGRES_URL (or DATABASE_URL) to .env.local.');
    process.exit(1);
  }

  const file = join(process.cwd(), 'config', 'field-mappings.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as MappingSet;
  const mappings = parsed.mappings ?? [];
  console.log(`Read ${mappings.length} mappings from config/field-mappings.json (v${parsed.version ?? '?'})`);

  const db = getDb();

  // Ensure the sync row exists.
  await db
    .insert(syncs)
    .values({ slug: DEFAULT_SYNC_SLUG, name: 'Contact ⇄ Company', sourceObject: 'contact', destObject: 'business' })
    .onConflictDoNothing({ target: syncs.slug });
  const sync = await db.query.syncs.findFirst({ where: eq(syncs.slug, DEFAULT_SYNC_SLUG) });
  if (!sync) throw new Error('failed to create/find sync row');

  const rows: NewFieldMappingRow[] = mappings.map((m, i) => ({
    syncId: sync.id,
    contactKey: m.contactKey,
    businessKey: m.businessKey,
    direction: m.direction,
    mirrorDown: m.mirrorDown ?? false,
    enabled: m.enabled ?? null,
    note: m.note ?? null,
    holdValues: m.holdValues ?? null,
    transform: m.transform ?? null,
    sortOrder: i,
  }));

  await db.delete(fieldMappings).where(eq(fieldMappings.syncId, sync.id));
  if (rows.length) await db.insert(fieldMappings).values(rows);

  console.log(`Seeded sync "${sync.slug}" (${sync.id}) with ${rows.length} field mappings.`);
  process.exit(0);
})().catch((e) => { console.error('SEED FAILED:', e?.stack ?? e); process.exit(2); });
