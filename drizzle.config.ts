// drizzle.config.ts — drizzle-kit config for schema push/generate.
//
//   npx drizzle-kit push       # create/update tables from lib/db/schema.ts
//   npx drizzle-kit generate   # emit SQL migration files (optional)
//
// Reads POSTGRES_URL from .env.local (Vercel Postgres connection string).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'drizzle-kit';

// Load .env.local so `drizzle-kit` sees POSTGRES_URL without extra tooling.
try {
  const txt = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* ok */ }

export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.POSTGRES_URL ?? '' },
});
