// lib/mapping/store.ts — persistence for the mapping table.
//
// Behind an interface so the backend can change without touching callers. The file-backed
// store (JSON in the repo) is the MVP: it reads everywhere (bundled with the app) and
// writes in local/dev. NOTE: Vercel's runtime filesystem is read-only, so runtime edits
// in production need a DB-backed store (Vercel KV/Postgres) — a drop-in future impl.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
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

/** Default store instance (file-backed at config/field-mappings.json). */
export const mappingStore: MappingStore = new FileMappingStore();
