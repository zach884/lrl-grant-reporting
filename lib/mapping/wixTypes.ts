// lib/mapping/wixTypes.ts — the config-as-data contract for a GHL -> Wix CMS sync.
//
// A WixMappingSet targets EXACTLY ONE Wix collection (per the product rule): pick a GHL
// source object, then map each source field to a column on the chosen collection. The set's
// matchKey (source field <-> target column) makes each sync an idempotent upsert, not a
// blind insert. Mirrors the shape of lib/mapping/types.ts but for a cross-system target.

/** Apply policy for an outbound write. Default 'overwrite' (Wix mirrors GHL). */
export type WixApplyPolicy = 'fill-empty' | 'overwrite';

/** Whether the sync may create a target row when none is found, or only update existing ones. */
export type WixCreatePolicy = 'update_only' | 'find_or_create';

/** What the engine does for a given gate-field value. Unlisted values default to 'skip'. */
export type GateAction = 'upsert' | 'update' | 'hide' | 'skip';

/**
 * Status→action gate, evaluated on the source record. Generic: works for any source object's status
 * field (contacts, custom objects). e.g. Team's contact.status → { Approved:'upsert', Published:'update',
 * Hidden:'hide', Pending:'skip' } with onPublishSetStatus:'Published'.
 */
export interface WixGate {
  /** Source field key that drives the gate (e.g. 'contact.status'). */
  field: string;
  /** field value -> action. Values not present here are treated as 'skip'. */
  actions: Record<string, GateAction>;
  /** After a successful create/publish, write this value back to `field` (e.g. 'Published'). */
  onPublishSetStatus?: string;
}

/** A first-link dedup key: match a source field to a target column when the hard key misses. */
export interface WixSecondaryMatch {
  sourceField: string;
  targetColumn: string;
}

/** How the engine shows/hides a row. `publishState` uses Wix's native Published/Draft (every Wix CMS
 *  supports it — hide=unpublish, show=publish). `column` is a fallback for a collection that instead
 *  filters its page on a real boolean/text column. */
export type WixVisibility =
  | { mode: 'publishState' }
  | { mode: 'column'; column: string; visibleValue: string; hiddenValue: string };

/** Value transforms for GHL field -> Wix column type gaps (see lib/wix/coerce.ts). */
export type WixTransform =
  | 'html' // LARGE_TEXT -> RICH_TEXT (wrap as <p>)
  | 'arrayFromMultiSelect' // MULTIPLE_OPTIONS -> ARRAY_STRING
  | 'imageFromUpload' // FILE_UPLOAD -> Wix Media import -> IMAGE
  | 'referenceFromOptions' // SINGLE/MULTIPLE_OPTIONS -> REFERENCE/MULTI_REFERENCE
  | 'countryCode'; // opaque 2-letter ISO passthrough

export interface WixMappingRow {
  /** GHL field key/id on the source object ("contact.bio") or a scalar ("email"). */
  sourceFieldKey: string;
  /** Existing Wix column key on the chosen collection ("bio", "image_fld"). */
  targetColumnKey: string;
  transform?: WixTransform;
  /** Per-row override of the set policy. undefined => use set default. */
  policy?: WixApplyPolicy;
}

export interface WixMappingSet {
  id: string;
  name: string;
  /** GHL source object: 'contact' | 'business' | `custom_objects.${string}`. */
  sourceObject: string;
  /** Wix target — a single collection on one site. */
  wixSiteId: string;
  wixCollectionId: string;
  /** Upsert key: source field ("id") matched to a Wix column ("ghlContactId"). */
  matchSourceField: string;
  matchTargetColumn: string;
  /** Set-level apply policy default. */
  policy: WixApplyPolicy;
  /** Create when no target found, or update-only. Defaults to 'find_or_create' when unset. */
  createPolicy?: WixCreatePolicy;
  /** Status→action gate on the source record. undefined => always upsert. */
  gate?: WixGate;
  /** First-link dedup keys tried when the hard match key misses. */
  secondaryMatch?: WixSecondaryMatch[];
  /** GHL field to write the created/linked target row id back to (e.g. 'contact.wix_team_row_id'). */
  writebackField?: string;
  /** Engine-controlled visibility column on the target collection. */
  visibility?: WixVisibility;
  enabled: boolean;
  version: number;
  updatedAt: string;
  rows: WixMappingRow[];
}

/** Lightweight summary for the "saved sets" list. */
export interface WixMappingSetSummary {
  id: string;
  name: string;
  sourceObject: string;
  wixCollectionId: string;
  rowCount: number;
  enabled: boolean;
  updatedAt: string;
}

/** A set input for create/update (id/version/updatedAt are assigned by the store). */
export type WixMappingSetInput = Omit<WixMappingSet, 'id' | 'version' | 'updatedAt'>;
