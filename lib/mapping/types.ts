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
  /** No-downgrade guard: values that must NEVER overwrite an existing (non-empty)
   *  contact value on down-sync. They MAY still fill an empty contact field.
   *  Motivating case: county="Other" (unresolved/non-MI) must not clobber a real county. */
  holdValues?: string[];
  /** Value transform for fields whose two sides encode the same thing differently.
   *  'countryCode': treat as an opaque 2-letter ISO code (uppercased) on BOTH sides —
   *  bypass the company field's SINGLE_OPTIONS label conversion (which would turn "US"
   *  into "United States") and compare case-insensitively. */
  transform?: 'countryCode';
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
  /** false if the company target type can't be written via the API on UPDATE
   *  (CHECKBOX/TEXTBOX_LIST always; MULTIPLE_OPTIONS on update). */
  businessWritable: boolean;
  /** true if the company target (MULTIPLE_OPTIONS) is writable ONLY at record creation. */
  businessCreateOnly: boolean;
  /** true when both sides are option types (single-select) and need key<->label handling. */
  optionType: boolean;
  issues: MappingIssue[];
}
