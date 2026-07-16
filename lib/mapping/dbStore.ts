// lib/mapping/dbStore.ts — Postgres-backed MappingStore (Vercel Postgres / Neon).
//
// Implements the same MappingStore contract as FileMappingStore so the sync engine and
// pages/api/sync/up.ts are unchanged. Adds slug-aware methods (loadSync/saveSync/listSyncs)
// for the editor API, and a short in-memory TTL cache so the webhook doesn't hit Postgres
// on every contact change (invalidated on save).

import { asc, eq } from 'drizzle-orm';
import { getDb } from '../db';
import { fieldMappings, syncs, type FieldMappingRow, type NewFieldMappingRow } from '../db/schema';
import type { FieldMapping, MappingSet, SyncDirection } from './types';
import type { MappingStore } from './store';

/** The single sync shipped in v1. Multi-sync is an additive follow-up. */
export const DEFAULT_SYNC_SLUG = 'contact-company';

const EMPTY: MappingSet = { version: 1, updatedAt: '', mappings: [] };
const TTL_MS = 10 * 60 * 1000;

export interface SyncSummary {
  slug: string;
  name: string;
  count: number;
  updatedAt: string;
  sourceObject: string;
  destObject: string;
  associationId: string | null;
}

export interface SyncMeta {
  slug: string;
  name: string;
  sourceObject: string;
  destObject: string;
  associationId: string | null;
  version: number;
  updatedAt: string;
}

/** Row -> domain object. Nulls collapse to `undefined` so `enabled` stays tri-state
 *  (undefined => enabled) and optional keys match the file-backed shape exactly. */
export function rowToMapping(r: FieldMappingRow): FieldMapping {
  const m: FieldMapping = {
    contactKey: r.contactKey,
    businessKey: r.businessKey,
    direction: r.direction as SyncDirection,
    mirrorDown: r.mirrorDown,
  };
  if (r.enabled !== null) m.enabled = r.enabled;
  if (r.note !== null && r.note !== '') m.note = r.note;
  if (r.holdValues && r.holdValues.length) m.holdValues = r.holdValues;
  if (r.transform) m.transform = r.transform;
  return m;
}

export class DbMappingStore implements MappingStore {
  private cache = new Map<string, { set: MappingSet; at: number }>();

  // --- MappingStore contract (engine-facing, single default sync) ---
  load(): Promise<MappingSet> {
    return this.loadSync(DEFAULT_SYNC_SLUG);
  }
  save(mappings: FieldMapping[]): Promise<MappingSet> {
    return this.saveSync(DEFAULT_SYNC_SLUG, mappings);
  }

  // --- slug-aware methods (editor-facing) ---
  async loadSync(slug: string): Promise<MappingSet> {
    const hit = this.cache.get(slug);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.set;

    const db = getDb();
    const sync = await db.query.syncs.findFirst({ where: eq(syncs.slug, slug) });
    if (!sync) return { ...EMPTY };

    const rows = await db
      .select()
      .from(fieldMappings)
      .where(eq(fieldMappings.syncId, sync.id))
      .orderBy(asc(fieldMappings.sortOrder));

    const set: MappingSet = {
      version: sync.version,
      updatedAt: sync.updatedAt instanceof Date ? sync.updatedAt.toISOString() : String(sync.updatedAt),
      mappings: rows.map(rowToMapping),
    };
    this.cache.set(slug, { set, at: Date.now() });
    return set;
  }

  async saveSync(slug: string, mappings: FieldMapping[]): Promise<MappingSet> {
    const db = getDb();
    const sync = await db.query.syncs.findFirst({ where: eq(syncs.slug, slug) });
    if (!sync) throw new Error(`sync not found: ${slug}`);

    const now = new Date();
    const nextVersion = sync.version + 1;
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

    // Atomic replace-all for this sync (neon-http batch = single transaction).
    const ops: any[] = [db.delete(fieldMappings).where(eq(fieldMappings.syncId, sync.id))];
    if (rows.length) ops.push(db.insert(fieldMappings).values(rows));
    ops.push(db.update(syncs).set({ version: nextVersion, updatedAt: now }).where(eq(syncs.id, sync.id)));
    await db.batch(ops as [any, ...any[]]);

    const set: MappingSet = { version: nextVersion, updatedAt: now.toISOString(), mappings };
    this.cache.set(slug, { set, at: Date.now() });
    return set;
  }

  async listSyncs(): Promise<SyncSummary[]> {
    const db = getDb();
    const rows = await db.select().from(syncs).orderBy(asc(syncs.name));
    const out: SyncSummary[] = [];
    for (const s of rows) {
      const set = await this.loadSync(s.slug);
      out.push({
        slug: s.slug,
        name: s.name,
        count: set.mappings.length,
        updatedAt: s.updatedAt instanceof Date ? s.updatedAt.toISOString() : String(s.updatedAt),
        sourceObject: s.sourceObject,
        destObject: s.destObject,
        associationId: s.associationId ?? null,
      });
    }
    return out;
  }

  /** A sync's object pairing + association (without its rows). */
  async getSyncMeta(slug: string): Promise<SyncMeta | null> {
    const db = getDb();
    const s = await db.query.syncs.findFirst({ where: eq(syncs.slug, slug) });
    if (!s) return null;
    return {
      slug: s.slug,
      name: s.name,
      sourceObject: s.sourceObject,
      destObject: s.destObject,
      associationId: s.associationId ?? null,
      version: s.version,
      updatedAt: s.updatedAt instanceof Date ? s.updatedAt.toISOString() : String(s.updatedAt),
    };
  }

  /** Create a new (empty) sync connection. Throws if the slug already exists. */
  async createSync(input: { slug: string; name: string; sourceObject: string; destObject: string; associationId?: string | null }): Promise<SyncMeta> {
    const db = getDb();
    const existing = await db.query.syncs.findFirst({ where: eq(syncs.slug, input.slug) });
    if (existing) throw new Error(`sync already exists: ${input.slug}`);
    const now = new Date();
    const [s] = await db
      .insert(syncs)
      .values({
        slug: input.slug,
        name: input.name,
        sourceObject: input.sourceObject,
        destObject: input.destObject,
        associationId: input.associationId ?? null,
        version: 1,
        updatedAt: now,
      })
      .returning();
    return {
      slug: s.slug, name: s.name, sourceObject: s.sourceObject, destObject: s.destObject,
      associationId: s.associationId ?? null, version: s.version, updatedAt: now.toISOString(),
    };
  }

  /** Delete a sync connection + its rows (field_mappings cascade). */
  async deleteSync(slug: string): Promise<void> {
    const db = getDb();
    await db.delete(syncs).where(eq(syncs.slug, slug));
    this.cache.delete(slug);
  }

  /** Drop cached mappings (all slugs, or one). Call after out-of-band writes (e.g. seed). */
  invalidate(slug?: string): void {
    if (slug) this.cache.delete(slug);
    else this.cache.clear();
  }
}
