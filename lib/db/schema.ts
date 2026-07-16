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

// ---------------------------------------------------------------------------
// GHL -> Wix CMS sync (additive; independent of the syncs/field_mappings above).
//
// Each `wix_mapping_sets` row is one outbound sync: a GHL source object mapped to
// exactly ONE Wix CMS collection, upserted by a match key. `wix_mapping_rows` holds
// the per-field mappings. Kept separate from the contact<->company tables because the
// target side is a Wix collection (site + collection + column), not a GHL object.
// ---------------------------------------------------------------------------

export const wixMappingSets = pgTable('wix_mapping_sets', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  /** Source system — 'ghl' for now (room for future sources). */
  sourceSystem: text('source_system').notNull().default('ghl'),
  /** GHL source object key: 'contact' | 'business' | 'custom_objects.<key>'. */
  sourceObject: text('source_object').notNull().default('contact'),
  /** Wix target: the site + the single collection this set writes to. */
  wixSiteId: text('wix_site_id').notNull(),
  wixCollectionId: text('wix_collection_id').notNull(),
  /** Upsert key: a source field ("id") matched to a Wix column ("ghlContactId"). */
  matchSourceField: text('match_source_field').notNull(),
  matchTargetColumn: text('match_target_column').notNull(),
  /** Set-level apply policy default: 'overwrite' | 'fill-empty'. Rows may override. */
  policy: text('policy').notNull().default('overwrite'),
  enabled: boolean('enabled').notNull().default(true),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const wixMappingRows = pgTable(
  'wix_mapping_rows',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    setId: uuid('set_id')
      .notNull()
      .references(() => wixMappingSets.id, { onDelete: 'cascade' }),
    /** GHL field key/id on the source object ("contact.bio" or a scalar like "email"). */
    sourceFieldKey: text('source_field_key').notNull(),
    /** Existing Wix column key on the chosen collection ("bio", "image_fld"). */
    targetColumnKey: text('target_column_key').notNull(),
    /** Optional value transform (e.g. 'html', 'imageFromUpload', 'referenceFromOptions'). */
    transform: text('transform'),
    /** Per-row policy override: 'overwrite' | 'fill-empty'. NULL => use the set default. */
    policy: text('policy'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => ({
    bySet: index('wix_mapping_rows_set_idx').on(t.setId, t.sortOrder),
    // One mapping per destination column within a set (upsert target).
    uniqTarget: unique('wix_mapping_rows_set_target_uq').on(t.setId, t.targetColumnKey),
  }),
);

export type WixMappingSetRow = typeof wixMappingSets.$inferSelect;
export type NewWixMappingSetRow = typeof wixMappingSets.$inferInsert;
export type WixMappingRowRow = typeof wixMappingRows.$inferSelect;
export type NewWixMappingRowRow = typeof wixMappingRows.$inferInsert;
