// lib/mapping/store.ts — persistence for the mapping table.
//
// Behind an interface so the backend can change without touching callers. Two impls:
//   - DbMappingStore  (Vercel Postgres) — used in prod; editable at runtime via the UI.
//   - FileMappingStore (JSON in the repo) — local/dev + scripts + tests fallback.
// The `mappingStore` singleton picks the DB store when POSTGRES_URL is set, else the file
// store, so callers (pages/api/sync/up.ts, scripts, the engine) never change.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { hasDatabase } from '@/lib/db';
import { DbMappingStore } from './dbStore';
import type { FieldMapping, MappingSet } from './types';

export interface MappingStore {
  load(): Promise<MappingSet>;
  save(mappings: FieldMapping[]): Promise<MappingSet>;
}

const DEFAULT_PATH = join(process.cwd(), 'config', 'field-mappings.json');

const EMPTY: MappingSet = { version: 1, updatedAt: '', mappings: [] };

export class FileMappingStore implements MappingStore {
  constructor(private readonly filePath: string = DEFAULT_PATH) {}

  async load(): Promise<MappingSet> {
    try {
      const txt = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(txt) as MappingSet;
      return { version: parsed.version ?? 1, updatedAt: parsed.updatedAt ?? '', mappings: parsed.mappings ?? [] };
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { ...EMPTY };
      throw err;
    }
  }

  async save(mappings: FieldMapping[]): Promise<MappingSet> {
    const current = await this.load();
    const next: MappingSet = {
      version: (current.version ?? 1) + (current.updatedAt ? 1 : 0),
      updatedAt: new Date().toISOString(),
      mappings,
    };
    await fs.mkdir(join(this.filePath, '..'), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(next, null, 2) + '\n', 'utf8');
    return next;
  }
}

/** DB store singleton (used by the editor API for slug-aware methods + cache invalidation).
 *  Only valid when POSTGRES_URL is set. */
let _dbStore: DbMappingStore | null = null;
export function getDbStore(): DbMappingStore {
  if (!hasDatabase) throw new Error('POSTGRES_URL is not set — DB mapping store unavailable');
  if (!_dbStore) _dbStore = new DbMappingStore();
  return _dbStore;
}

/** Default store: Postgres in prod (POSTGRES_URL set), file-backed locally/in scripts. */
export const mappingStore: MappingStore = hasDatabase ? getDbStore() : new FileMappingStore();
