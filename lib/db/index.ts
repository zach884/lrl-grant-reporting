// lib/db/index.ts — Drizzle client over Vercel Postgres (Neon serverless).
//
// Vercel injects POSTGRES_URL when you attach a Postgres store to the project. We use the
// neon-http driver (stateless, fits serverless functions). Import `db` where you need it;
// import the schema via `@/lib/db/schema`.

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

const connectionString = process.env.POSTGRES_URL;

/** True when a Postgres connection is configured (used by the store factory to pick backend). */
export const hasDatabase = Boolean(connectionString);

// Lazily construct so importing this module never throws when POSTGRES_URL is absent
// (e.g. local scripts/tests running on the file-backed store).
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!connectionString) {
    throw new Error('POSTGRES_URL is not set — no database configured');
  }
  if (!_db) {
    _db = drizzle(neon(connectionString), { schema });
  }
  return _db;
}

export { schema };
