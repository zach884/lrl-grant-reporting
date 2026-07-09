// lib/db/schema.ts — Postgres schema for the DB-backed mapping store.
//
// Two tables: `syncs` (one row per named sync; v1 seeds a single "contact-company" row)
// and `field_mappings` (the rows of one sync). The columns mirror the FieldMapping
// contract in lib/mapping/types.ts EXACTLY so a row round-trips to the shape the sync
// engine already consumes — nothing in lib/sync/* changes.

import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, unique, index } from 'drizzle-orm/pg-core';

export const syncs = pgTable('syncs', {
  id: uuid('id').defaultRandom().primaryKey(),
  /** Stable, human-readable key used by the store/API (e.g. "contact-company"). */
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  /** Object identifiers for the two sides (v1: "contact" / "business"). */
  sourceObject: text('source_object').notNull().default('contact'),
  destObject: text('dest_object').notNull().default('business'),
  /** Bumped on every save; mirrors MappingSet.version. */
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const fieldMappings = pgTable(
  'field_mappings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    syncId: uuid('sync_id')
      .notNull()
      .references(() => syncs.id, { onDelete: 'cascade' }),

    // --- FieldMapping contract (lib/mapping/types.ts) ---
    contactKey: text('contact_key').notNull(),
    businessKey: text('business_key').notNull(),
    /** 'up' | 'down' | 'both' — kept as text; validated in the store/API layer. */
    direction: text('direction').notNull(),
    mirrorDown: boolean('mirror_down').notNull().default(false),
    /** Tri-state at the domain layer: NULL => treated as enabled (enabled !== false). */
    enabled: boolean('enabled'),
    note: text('note'),
    /** No-downgrade guard values; stored as a JSON string[]. */
    holdValues: jsonb('hold_values').$type<string[]>(),
    /** Value transform, e.g. 'countryCode'. NULL => none. */
    transform: text('transform').$type<'countryCode'>(),

    /** Display + load order within a sync. */
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => ({
    bySync: index('field_mappings_sync_idx').on(t.syncId, t.sortOrder),
    // A destination/source pair is unique within a sync (upsert target for the seed).
    uniqPair: unique('field_mappings_sync_pair_uq').on(t.syncId, t.contactKey, t.businessKey),
  }),
);

export type SyncRow = typeof syncs.$inferSelect;
export type FieldMappingRow = typeof fieldMappings.$inferSelect;
export type NewFieldMappingRow = typeof fieldMappings.$inferInsert;
