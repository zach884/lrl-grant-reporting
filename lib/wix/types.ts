// lib/wix/types.ts — typed shapes for the Wix Data + Media objects we touch.
// Grounded in the live Team collection schema probe (2026-07-16).

/** Wix CMS column data types seen on LRL collections (+ common extras). */
export type WixFieldType =
  | 'TEXT'
  | 'RICH_TEXT'
  | 'RICH_CONTENT'
  | 'NUMBER'
  | 'URL'
  | 'EMAIL'
  | 'DATE'
  | 'DATETIME'
  | 'TIME'
  | 'BOOLEAN'
  | 'IMAGE'
  | 'DOCUMENT'
  | 'VIDEO'
  | 'AUDIO'
  | 'ARRAY_STRING'
  | 'ARRAY_DOCUMENT'
  | 'OBJECT'
  | 'REFERENCE'
  | 'MULTI_REFERENCE'
  | 'PAGE_LINK'
  | 'MEDIA_GALLERY'
  | 'ADDRESS';

export interface WixColumn {
  key: string;
  displayName: string;
  type: WixFieldType | string;
  systemField?: boolean;
  readOnly?: boolean;
  /** For (MULTI_)REFERENCE: the collection this column points at. */
  referencedCollectionId?: string;
  /** For MULTI_REFERENCE: the field key used on the referring item for reference writes. */
  referencingFieldKey?: string;
}

export interface WixCollectionSchema {
  id: string;
  displayName: string;
  /** The primary display column (e.g. "title_fld"). */
  displayField?: string;
  columns: WixColumn[];
}

export interface WixCollectionSummary {
  id: string;
  displayName: string;
}

/** A CMS data item: opaque bag of column key -> value, plus system fields. */
export interface WixItem {
  _id?: string;
  [key: string]: unknown;
}
