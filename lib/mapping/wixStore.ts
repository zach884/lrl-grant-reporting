// lib/mapping/wixStore.ts — Postgres-backed store for GHL -> Wix mapping sets.
//
// Mirrors DbMappingStore (lib/mapping/dbStore.ts): slug/id-aware CRUD over the
// wix_mapping_sets + wix_mapping_rows tables, plus a short in-memory TTL cache so the
// webhook doesn't hit Postgres on every source-record change (invalidated on write).

import { asc, eq } from 'drizzle-orm';
import { getDb, hasDatabase } from '../db';
import {
  wixMappingRows,
  wixMappingSets,
  type NewWixMappingRowRow,
  type WixMappingRowRow,
  type WixMappingSetRow,
} from '../db/schema';
import type {
  WixApplyPolicy,
  WixCreatePolicy,
  WixMappingRow,
  WixMappingSet,
  WixMappingSetInput,
  WixMappingSetSummary,
  WixTransform,
} from './wixTypes';

const TTL_MS = 10 * 60 * 1000;

function rowToMappingRow(r: WixMappingRowRow): WixMappingRow {
  const m: WixMappingRow = { sourceFieldKey: r.sourceFieldKey, targetColumnKey: r.targetColumnKey };
  if (r.transform) m.transform = r.transform as WixTransform;
  if (r.policy) m.policy = r.policy as WixApplyPolicy;
  return m;
}

function toSet(set: WixMappingSetRow, rows: WixMappingRowRow[]): WixMappingSet {
  const out: WixMappingSet = {
    id: set.id,
    name: set.name,
    sourceObject: set.sourceObject,
    wixSiteId: set.wixSiteId,
    wixCollectionId: set.wixCollectionId,
    matchSourceField: set.matchSourceField,
    matchTargetColumn: set.matchTargetColumn,
    policy: set.policy as WixApplyPolicy,
    createPolicy: (set.createPolicy ?? 'find_or_create') as WixCreatePolicy,
    enabled: set.enabled,
    version: set.version,
    updatedAt: set.updatedAt instanceof Date ? set.updatedAt.toISOString() : String(set.updatedAt),
    rows: rows.map(rowToMappingRow),
  };
  if (set.gate) out.gate = set.gate;
  if (set.secondaryMatch) out.secondaryMatch = set.secondaryMatch;
  if (set.writebackField) out.writebackField = set.writebackField;
  if (set.visibility) out.visibility = set.visibility;
  return out;
}

export class WixMappingStore {
  private cache = new Map<string, { set: WixMappingSet; at: number }>();

  async listSets(): Promise<WixMappingSetSummary[]> {
    const db = getDb();
    const sets = await db.select().from(wixMappingSets).orderBy(asc(wixMappingSets.name));
    const out: WixMappingSetSummary[] = [];
    for (const s of sets) {
      const set = await this.getSet(s.id);
      out.push({
        id: s.id,
        name: s.name,
        sourceObject: s.sourceObject,
        wixCollectionId: s.wixCollectionId,
        rowCount: set?.rows.length ?? 0,
        enabled: s.enabled,
        updatedAt: s.updatedAt instanceof Date ? s.updatedAt.toISOString() : String(s.updatedAt),
      });
    }
    return out;
  }

  async getSet(id: string): Promise<WixMappingSet | null> {
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.set;

    const db = getDb();
    const set = await db.query.wixMappingSets.findFirst({ where: eq(wixMappingSets.id, id) });
    if (!set) return null;
    const rows = await db
      .select()
      .from(wixMappingRows)
      .where(eq(wixMappingRows.setId, id))
      .orderBy(asc(wixMappingRows.sortOrder));

    const full = toSet(set, rows);
    this.cache.set(id, { set: full, at: Date.now() });
    return full;
  }

  /** All enabled sets whose source object matches (the webhook's dispatch list). */
  async setsForSource(sourceObject: string): Promise<WixMappingSet[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(wixMappingSets)
      .where(eq(wixMappingSets.sourceObject, sourceObject));
    const out: WixMappingSet[] = [];
    for (const s of rows) {
      if (!s.enabled) continue;
      const full = await this.getSet(s.id);
      if (full) out.push(full);
    }
    return out;
  }

  async createSet(input: WixMappingSetInput): Promise<WixMappingSet> {
    const db = getDb();
    const now = new Date();
    const [set] = await db
      .insert(wixMappingSets)
      .values({
        name: input.name,
        sourceObject: input.sourceObject,
        wixSiteId: input.wixSiteId,
        wixCollectionId: input.wixCollectionId,
        matchSourceField: input.matchSourceField,
        matchTargetColumn: input.matchTargetColumn,
        policy: input.policy,
        createPolicy: input.createPolicy ?? 'find_or_create',
        gate: input.gate ?? null,
        secondaryMatch: input.secondaryMatch ?? null,
        writebackField: input.writebackField ?? null,
        visibility: input.visibility ?? null,
        enabled: input.enabled,
        version: 1,
        updatedAt: now,
      })
      .returning();
    if (input.rows.length) {
      await db.insert(wixMappingRows).values(input.rows.map((r, i) => this.toRow(set.id, r, i)));
    }
    this.cache.delete(set.id);
    return (await this.getSet(set.id))!;
  }

  /** Replace a set's header + all rows atomically; bumps version. */
  async saveSet(id: string, input: WixMappingSetInput): Promise<WixMappingSet> {
    const db = getDb();
    const existing = await db.query.wixMappingSets.findFirst({ where: eq(wixMappingSets.id, id) });
    if (!existing) throw new Error(`wix mapping set not found: ${id}`);

    const now = new Date();
    const nextVersion = existing.version + 1;
    const newRows: NewWixMappingRowRow[] = input.rows.map((r, i) => this.toRow(id, r, i));

    const ops: any[] = [db.delete(wixMappingRows).where(eq(wixMappingRows.setId, id))];
    if (newRows.length) ops.push(db.insert(wixMappingRows).values(newRows));
    ops.push(
      db
        .update(wixMappingSets)
        .set({
          name: input.name,
          sourceObject: input.sourceObject,
          wixSiteId: input.wixSiteId,
          wixCollectionId: input.wixCollectionId,
          matchSourceField: input.matchSourceField,
          matchTargetColumn: input.matchTargetColumn,
          policy: input.policy,
          // PRESERVE engine-critical config the editor UI doesn't manage: only overwrite when the
          // caller EXPLICITLY provides a value (undefined => keep existing). Without this, a UI save
          // (sanitizeWixSet omits these) silently nulled the status gate → find_or_create upserted
          // every contact and flooded the CMS. `null` still clears explicitly (a real gate editor).
          createPolicy: input.createPolicy ?? existing.createPolicy ?? 'find_or_create',
          gate: input.gate !== undefined ? input.gate : (existing.gate ?? null),
          secondaryMatch: input.secondaryMatch !== undefined ? input.secondaryMatch : (existing.secondaryMatch ?? null),
          writebackField: input.writebackField !== undefined ? input.writebackField : (existing.writebackField ?? null),
          visibility: input.visibility !== undefined ? input.visibility : (existing.visibility ?? null),
          enabled: input.enabled,
          version: nextVersion,
          updatedAt: now,
        })
        .where(eq(wixMappingSets.id, id)),
    );
    await db.batch(ops as [any, ...any[]]);

    this.cache.delete(id);
    return (await this.getSet(id))!;
  }

  async deleteSet(id: string): Promise<void> {
    const db = getDb();
    await db.delete(wixMappingSets).where(eq(wixMappingSets.id, id)); // rows cascade
    this.cache.delete(id);
  }

  invalidate(id?: string): void {
    if (id) this.cache.delete(id);
    else this.cache.clear();
  }

  private toRow(setId: string, r: WixMappingRow, i: number): NewWixMappingRowRow {
    return {
      setId,
      sourceFieldKey: r.sourceFieldKey,
      targetColumnKey: r.targetColumnKey,
      transform: r.transform ?? null,
      policy: r.policy ?? null,
      sortOrder: i,
    };
  }
}

let _wixStore: WixMappingStore | null = null;
export function getWixStore(): WixMappingStore {
  if (!hasDatabase) throw new Error('POSTGRES_URL is not set — Wix mapping store unavailable');
  if (!_wixStore) _wixStore = new WixMappingStore();
  return _wixStore;
}
