// lib/mapping/wixTypes.ts — the config-as-data contract for a GHL -> Wix CMS sync.
//
// A WixMappingSet targets EXACTLY ONE Wix collection (per the product rule): pick a GHL
// source object, then map each source field to a column on the chosen collection. The set's
// matchKey (source field <-> target column) makes each sync an idempotent upsert, not a
// blind insert. Mirrors the shape of lib/mapping/types.ts but for a cross-system target.

/** Apply policy for an outbound write. Default 'overwrite' (Wix mirrors GHL). */
export type WixApplyPolicy = 'fill-empty' | 'overwrite';

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
