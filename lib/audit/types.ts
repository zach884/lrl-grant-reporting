// lib/audit/types.ts — shapes for the change log (see docs/sprints/change-log-plan.md).

/** One field's before→after, with optional per-field provenance (enrichers carry source/rationale). */
export interface ChangeLogFieldChange {
  field: string;
  from?: unknown;
  to: unknown;
  source?: string;
  method?: string;
  confidence?: number;
  rationale?: string;
}

/** A single change event: one actor changed one record's field(s). */
export interface ChangeLogEvent {
  /** 'ghl' | 'wix'. Default 'ghl'. */
  app?: string;
  /** Target object: 'contact' | 'business' | 'custom_objects.business_stage' | 'wix:<collection>'. */
  objectType: string;
  recordId: string;
  /** Best-effort human label (company/contact name). */
  recordLabel?: string;
  actorKind: 'sync' | 'enricher' | 'scorer';
  /** e.g. 'contact-to-company', 'naics', 'client-stage-scorer'. */
  actorName: string;
  action?: 'create' | 'update';
  changes: ChangeLogFieldChange[];
  /** Actor-level provenance (for single-method actors like the scorer). */
  method?: string;
  confidence?: number;
  rationale?: string;
  /** false = dry-run (would-write). Default true. */
  applied?: boolean;
  error?: string;
}
