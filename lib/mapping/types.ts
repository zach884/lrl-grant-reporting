// lib/mapping/types.ts — the single contact<->company field-mapping contract.
//
// This is the "config-as-data" table the roadmap calls for: ONE declarative map that
// both the native UP-sync (contact -> its company) and the app DOWN-sync (company ->
// all associated contacts) obey. Adding a synced field = one row here, not a new
// per-form workflow.

export type SyncDirection = 'up' | 'down' | 'both';

/** One row of the field-mapping table. */
export interface FieldMapping {
  /** Contact side. Either a custom-field key ("contact.naics_code") or a scalar
   *  ("companyName" — the legacy free-text box some reports read). */
  contactKey: string;
  /** Company side, custom-field key ("business.naics_code") or scalar ("name"). */
  businessKey: string;
  /** up = contact->company, down = company->contacts, both = kept in sync either way. */
  direction: SyncDirection;
  /** If true, this field is part of the minimal "mirror-down" subset actually consumed
   *  by GHL contact-triggered automations / legacy reports. Keep this set small —
   *  every mirrored field is drift surface. */
  mirrorDown: boolean;
  /** Optional human note (e.g. why it's mirrored). */
  note?: string;
  /** Set false to keep a row in the table but stop syncing it. */
  enabled?: boolean;
}

export interface MappingSet {
  version: number;
  updatedAt: string;
  mappings: FieldMapping[];
}

export type MappingIssueLevel = 'error' | 'warning';

export interface MappingIssue {
  level: MappingIssueLevel;
  contactKey: string;
  businessKey: string;
  message: string;
}

/** A mapping annotated with what we learned from the live catalogs. */
export interface ResolvedFieldMapping extends FieldMapping {
  contactDataType?: string;
  businessDataType?: string;
  contactName?: string;
  businessName?: string;
  /** contact-side field exists in the live catalog (scalars are always considered present). */
  contactExists: boolean;
  businessExists: boolean;
  /** false if the company target type can't be written via the API (CHECKBOX/TEXTBOX_LIST/MULTIPLE_OPTIONS). */
  businessWritable: boolean;
  /** true when both sides are option types (single-select) and need key<->label handling. */
  optionType: boolean;
  issues: MappingIssue[];
}
