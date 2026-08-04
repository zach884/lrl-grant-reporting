// lib/db/schema.ts — Postgres schema for the DB-backed mapping store.
//
// Two tables: `syncs` (one row per named sync; v1 seeds a single "contact-company" row)
// and `field_mappings` (the rows of one sync). The columns mirror the FieldMapping
// contract in lib/mapping/types.ts EXACTLY so a row round-trips to the shape the sync
// engine already consumes — nothing in lib/sync/* changes.

import { pgTable, uuid, text, integer, real, boolean, jsonb, timestamp, unique, index, primaryKey } from 'drizzle-orm/pg-core';
import type { WixCreatePolicy, WixGate, WixSecondaryMatch, WixVisibility } from '../mapping/wixTypes';
import type { EnricherFilter, EnricherGroup, EnricherMembership, EnricherStatusGate, FilterCombine } from '../enrichment/configTypes';
import type { ChangeLogFieldChange } from '../audit/types';

export const syncs = pgTable('syncs', {
  id: uuid('id').defaultRandom().primaryKey(),
  /** Stable, human-readable key used by the store/API (e.g. "contact-company"). */
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  /** Object identifiers for the two sides (v1: "contact" / "business"). */
  sourceObject: text('source_object').notNull().default('contact'),
  destObject: text('dest_object').notNull().default('business'),
  /** For GHL↔GHL syncs of other object pairs: which GHL association to traverse.
   *  NULL for the legacy contact-company sync (it uses the contact.businessId scalar). */
  associationId: text('association_id'),
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
  /** Create-when-missing vs update-only. */
  createPolicy: text('create_policy').notNull().default('find_or_create').$type<WixCreatePolicy>(),
  /** Status→action gate on the source record (JSON). NULL => always upsert. */
  gate: jsonb('gate').$type<WixGate>(),
  /** First-link dedup keys tried when the hard match key misses (JSON array). */
  secondaryMatch: jsonb('secondary_match').$type<WixSecondaryMatch[]>(),
  /** GHL field to write the created/linked target row id back to. */
  writebackField: text('writeback_field'),
  /** Engine-controlled visibility column on the target collection (JSON). */
  visibility: jsonb('visibility').$type<WixVisibility>(),
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

// ---------------------------------------------------------------------------
// Enricher gate config (additive). One row per (enricher, sourceObject): the WHEN/WHERE an
// enricher runs, editable in /enrichment. The enricher TRANSFORM stays in code — this only holds
// the status gate (runOn) + membership gate (anyOf). A missing row => the code default applies
// (today's hardcoded behavior), so seeding is optional for correctness and only pins it visibly.
// ---------------------------------------------------------------------------

export const enricherConfigs = pgTable(
  'enricher_configs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** Enricher registry name, e.g. 'readiness-tagger'. */
    enricher: text('enricher').notNull(),
    /** Source object the enricher targets: 'contact' | 'business' | 'custom_objects.<key>'. */
    sourceObject: text('source_object').notNull().default('contact'),
    enabled: boolean('enabled').notNull().default(true),
    /** Groups (current model): each {combine, filters[]}; groups combine per `combine`. NULL/[] => always run. */
    groups: jsonb('groups').$type<EnricherGroup[]>(),
    /** How the GROUPS combine at the top level: 'AND' | 'OR'. NULL => 'AND'. (Under the pre-groups
     *  model this held the across-filters combine; back-compat read handles that.) */
    combine: text('combine').$type<FilterCombine>(),
    /** @deprecated pre-groups flat filter list — read for back-compat; new saves write NULL. */
    filters: jsonb('filters').$type<EnricherFilter[]>(),
    /** @deprecated legacy status gate {field, runOn[]} — read for back-compat; new saves write NULL. */
    gate: jsonb('gate').$type<EnricherStatusGate>(),
    /** @deprecated legacy membership gate {field, anyOf[]} — read for back-compat; new saves write NULL. */
    membership: jsonb('membership').$type<EnricherMembership>(),
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One config per enricher per source object (upsert target).
    uniqEnricher: unique('enricher_configs_enricher_source_uq').on(t.enricher, t.sourceObject),
  }),
);

export type EnricherConfigRow = typeof enricherConfigs.$inferSelect;
export type NewEnricherConfigRow = typeof enricherConfigs.$inferInsert;

// ---------------------------------------------------------------------------
// Per-company enricher STATE (additive). Lets real-time enrichers gate on the record's state
// instead of on whether the app's up-sync produced a diff (which is empty when GHL's native sync
// populated the company first). `score_input_hash` = fingerprint of the last-scored inputs, so the
// scorer recomputes only when the inputs actually changed (no Claude call otherwise); create =>
// no row => it runs. `geocoded_address` = the address county/geo last ran on, so they re-run on a
// real address change (not every edit). A missing row => "never processed" => everything runs.
// ---------------------------------------------------------------------------

export const enricherState = pgTable('enricher_state', {
  /** GHL company (business) record id. */
  companyId: text('company_id').primaryKey(),
  /** Fingerprint of the scoring-input blob at the last score. NULL => never scored. */
  scoreInputHash: text('score_input_hash'),
  /** Normalized address county/geo last geocoded. NULL => never geocoded. */
  geocodedAddress: text('geocoded_address'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type EnricherStateRow = typeof enricherState.$inferSelect;
export type NewEnricherStateRow = typeof enricherState.$inferInsert;

// ---------------------------------------------------------------------------
// Sync write ledger (additive) — powers the runtime CONVERGENCE GUARD. Records the last value the
// sync WROTE to each (record, field). If a later sync re-proposes a value we already wrote but the
// field's current value isn't that value (it didn't "stick" — e.g. GHL normalized a country scalar
// back to "US" after we wrote "United States"), the write is non-converging and gets suppressed
// instead of churning forever. Only fields that actually change are ever written here.
// ---------------------------------------------------------------------------

export const syncWriteLedger = pgTable(
  'sync_write_ledger',
  {
    /** Target record the value was written to. */
    recordId: text('record_id').notNull(),
    /** Target field key (e.g. 'country', 'contact.geographically_disadvantaged'). */
    fieldKey: text('field_key').notNull(),
    /** Normalized form of the last value we wrote (for equality comparison). */
    lastValue: text('last_value'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.recordId, t.fieldKey] }) }),
);

export type SyncWriteLedgerRow = typeof syncWriteLedger.$inferSelect;

// ---------------------------------------------------------------------------
// Change log (additive, append-only) — a durable history of every change the app makes to a connected
// system (GHL, Wix): which record, which field(s) before→after, which sync/enricher/scorer, why, when,
// what triggered it, and applied vs dry-run. Powers debugging + the funder audit trail. Written
// best-effort (a log failure never breaks a write). See docs/sprints/change-log-plan.md.
// ---------------------------------------------------------------------------

export const changeLog = pgTable(
  'change_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    app: text('app').notNull().default('ghl'),
    objectType: text('object_type').notNull(),
    recordId: text('record_id').notNull(),
    recordLabel: text('record_label'),
    /** 'sync' | 'enricher' | 'scorer'. */
    actorKind: text('actor_kind').notNull(),
    actorName: text('actor_name').notNull(),
    action: text('action').notNull().default('update'),
    /** Field diffs (+ per-field provenance) as JSON. */
    changes: jsonb('changes').$type<ChangeLogFieldChange[]>(),
    method: text('method'),
    confidence: real('confidence'),
    rationale: text('rationale'),
    /** 'webhook:contact-changed' | 'batch:<script>' | 'manual'. */
    trigger: text('trigger'),
    /** Correlates all writes from one invocation (webhook/batch). */
    runId: text('run_id'),
    applied: boolean('applied').notNull().default(true),
    error: text('error'),
  },
  (t) => ({
    byRecord: index('change_log_record_idx').on(t.recordId, t.ts),
    byRun: index('change_log_run_idx').on(t.runId),
    byActor: index('change_log_actor_idx').on(t.actorName, t.ts),
    byTs: index('change_log_ts_idx').on(t.ts),
  }),
);

export type ChangeLogRow = typeof changeLog.$inferSelect;
