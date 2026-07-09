// lib/ghl/types.ts — typed shapes for the GHL objects we touch.
// Grounded in live response probes (2026-07-07), not just docs.

/** GHL custom-field data types seen on the business + contact objects. */
export type GhlDataType =
  | 'TEXT'
  | 'LARGE_TEXT'
  | 'NUMERICAL'
  | 'PHONE'
  | 'EMAIL'
  | 'DATE'
  | 'SINGLE_OPTIONS'
  | 'MULTIPLE_OPTIONS'
  | 'CHECKBOX'
  | 'TEXTBOX_LIST'
  | 'RADIO'
  | 'FILE_UPLOAD'
  | 'SIGNATURE'
  | 'MONETORY';

export interface GhlFieldOption {
  key: string;
  label: string;
}

/** A custom-field definition as returned by the catalog endpoints. */
export interface CustomFieldDef {
  id: string;
  name: string;
  /** e.g. "business.lara_id" or "contact.naics_code". */
  fieldKey: string;
  dataType: GhlDataType;
  /** Folder id (business object only). */
  parentId?: string;
  /** Present inconsistently on reads — verify option lists in the UI when it matters. */
  options?: GhlFieldOption[];
  /** TEXTBOX_LIST rows (each a labeled text box). Value is stored as { rowId: text }. */
  rows?: Array<{ id: string; label: string }>;
}

export interface CustomFieldFolder {
  id: string;
  name: string;
}

export interface CustomFieldCatalog {
  fields: CustomFieldDef[];
  folders: CustomFieldFolder[];
  /** fieldKey -> def, for O(1) lookup by mapping/coercion code. */
  byKey: Record<string, CustomFieldDef>;
  /** id -> def, for resolving contact customFields (which key by id). */
  byId: Record<string, CustomFieldDef>;
}

/** Company record via the objects API. `properties` keys are BARE (no "business." prefix). */
export interface BusinessRecord {
  id: string;
  locationId?: string;
  objectKey?: string;
  /** bareKey -> value. Single-selects read back as option KEYS; dates as YYYY-MM-DD. */
  properties: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/** Lightweight company row from the legacy /businesses/ list endpoint. */
export interface BusinessListItem {
  id: string;
  name: string;
  postalCode?: string;
  /** Legacy list returns customFields as [{ key, valueString | valueNumber }] (not the objects shape). */
  customFields?: Array<{ key?: string; valueString?: string; valueNumber?: number; value?: unknown }>;
}

/** Contact custom-field value as returned on a contact record (keyed by id). */
export interface ContactCustomFieldValue {
  id: string;
  value?: unknown;
}

export interface Contact {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  /** Legacy free-text "Company Name" box some automations read. */
  companyName?: string;
  /** Associated Company id (this is the scalar GHL fills, NOT `companyId`). */
  businessId?: string;
  /** Standard address-block scalars (GHL contact street line is `address1`). */
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  website?: string;
  customFields?: ContactCustomFieldValue[];
}
