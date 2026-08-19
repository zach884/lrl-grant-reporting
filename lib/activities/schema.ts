// lib/activities/schema.ts — what each activity type is made of.
//
// `custom_objects.activities` is ONE wide object (101 fields) discriminated by `activity_type`, so
// every consumer needs the same answer to "which fields belong to this type?". That answer comes
// from the LIVE field catalog by FOLDER, not from a list in this file:
//
//   intake → (core only) · technical_assistance → "Technical Assistance" · introduction_referral →
//   "Referral" · workshop_event → "Event" · grant → "Grant" · metrics → "Metrics"
//
// So a field added to a folder in GHL shows up in the form with no code change — the same
// config-as-data property the mapping engine has. What IS hand-authored here is policy, because it
// isn't derivable from schema: which fields make a log complete (`required`), which are worth showing
// before "More fields" (`prominent`), and the two folder placements that lie (below).
//
// Scope note (Zach, 2026-08-19): grant + metrics arrive from GHL forms, not staff entry, so they are
// `staffLogged: false` — rendered in the timeline, never offered as a form. See
// docs/sprints/activity-tracking.md.

import type { CustomFieldCatalog, CustomFieldDef } from '../ghl/types';

export const ACTIVITIES_OBJECT = 'custom_objects.activities';

/** The folder holding the fields every type shares. */
export const CORE_FOLDER = 'Activity Info';

export type ActivityTypeKey =
  | 'intake'
  | 'technical_assistance'
  | 'introduction_referral'
  | 'workshop_event'
  | 'grant'
  | 'metrics'
  | 'program_acceptance';

export interface ActivityTypeDef {
  key: ActivityTypeKey;
  label: string;
  /** Field folder whose fields belong to this type. null = core only. */
  folder: string | null;
  /** False for types fed by a GHL form rather than typed by staff. */
  staffLogged: boolean;
  /** Bare keys that must be present for the log to count as complete. */
  required: string[];
  /** Bare keys shown before "More fields", in this order. */
  prominent: string[];
  /** Core-folder keys that belong to THIS type only (see CORE_TYPE_SPECIFIC). */
  extraFields?: string[];
}

/**
 * Two core-folder fields are not really core, and the folder can't say so:
 *   • `referral_type`  — sits in Activity Info for historical reasons; it is a Referral field.
 *   • `appointment_id` — the Sprint-5 Zoom auto-log hook, never hand-typed.
 * Both are excluded from core and re-attached where they belong.
 */
export const CORE_TYPE_SPECIFIC = new Set(['referral_type', 'appointment_id']);

/**
 * Fields the INGESTION LAYER owns. They live in the core folder because that is where record
 * identity belongs, but a person must never hand-edit them: `source_record_id` is the idempotency
 * key, so a typo there would make the next delivery of that event create a duplicate record.
 * (Both carry the `[SYNC]` name prefix in GHL for the same reason.)
 */
export const MACHINE_FIELDS = new Set([
  'activity_source', 'source_record_id', 'appointment_status', 'zoom_meeting_id', 'grant_status',
  // Set by the referral picker, not typed: the picker writes the name AND the record it points at.
  'counterparty_kind', 'counterparty_id',
]);

export const ACTIVITY_TYPES: ActivityTypeDef[] = [
  {
    key: 'intake',
    label: 'Intake',
    folder: null,
    staffLogged: true,
    required: [],
    prominent: [],
  },
  {
    key: 'technical_assistance',
    label: 'Technical Assistance',
    folder: 'Technical Assistance',
    staffLogged: true,
    required: ['modality', 'service_topic'],
    prominent: ['modality', 'service_topic'],
  },
  {
    key: 'introduction_referral',
    label: 'Introduction / Referral',
    folder: 'Referral',
    staffLogged: true,
    required: ['referral_type', 'counterparty_name'],
    prominent: ['referral_type', 'counterparty_name', 'referral_reason'],
    extraFields: ['referral_type'],
  },
  {
    key: 'workshop_event',
    label: 'Workshop / Event',
    folder: 'Event',
    staffLogged: true,
    required: ['event_name', 'event_type', 'attended'],
    prominent: ['event_name', 'event_type', 'registered', 'attended'],
  },
  {
    key: 'grant',
    label: 'Grant',
    folder: 'Grant',
    staffLogged: false,
    required: [],
    prominent: ['grant_program', 'award_amount', 'award_date'],
  },
  {
    key: 'metrics',
    label: 'Metrics',
    folder: 'Metrics',
    staffLogged: false,
    required: [],
    prominent: ['reporting_period'],
  },
  {
    // The 7th type, added 2026-08-19. Not a meeting — the record that a company ENTERED a program,
    // which is what gives the report engine each company's enrollment intervals. Comes from an
    // opportunity reaching an accepted stage; never hand-logged.
    key: 'program_acceptance',
    label: 'Program Acceptance',
    folder: null,
    staffLogged: false,
    required: [],
    prominent: ['program__grant_association'],
  },
];

const BY_KEY = new Map(ACTIVITY_TYPES.map((t) => [t.key, t]));

export function activityType(key: string): ActivityTypeDef | undefined {
  return BY_KEY.get(key as ActivityTypeKey);
}

export function staffLoggedTypes(): ActivityTypeDef[] {
  return ACTIVITY_TYPES.filter((t) => t.staffLogged);
}

/** Bare key of a field def, whatever prefix form its fieldKey has. */
export function bareKey(def: CustomFieldDef): string {
  return def.fieldKey.startsWith(`${ACTIVITIES_OBJECT}.`)
    ? def.fieldKey.slice(ACTIVITIES_OBJECT.length + 1)
    : def.fieldKey;
}

function folderName(catalog: CustomFieldCatalog, def: CustomFieldDef): string | undefined {
  return catalog.folders?.find((f) => f.id === def.parentId)?.name;
}

const byPosition = (a: CustomFieldDef, b: CustomFieldDef) =>
  (a.position ?? 1e6) - (b.position ?? 1e6) || a.name.localeCompare(b.name);

export interface ActivityFieldSet {
  /** Core fields shown for every type (`activity_type` excluded — it is the discriminator). */
  core: CustomFieldDef[];
  /** This type's own fields, prominent ones first, then the rest in catalog order. */
  typeFields: CustomFieldDef[];
  /** typeFields that are prominent (shown before "More fields"). */
  prominent: CustomFieldDef[];
  /** Bare keys required for a complete log. */
  required: string[];
}

/**
 * The fields that make up one activity type, resolved against the live catalog.
 * Unknown type → empty set with `required: []` (the caller refuses the write; see validate()).
 */
export function activityFieldSet(catalog: CustomFieldCatalog, type: string): ActivityFieldSet {
  const def = activityType(type);
  const all = catalog.fields ?? [];
  const inFolder = (name: string) => all.filter((f) => folderName(catalog, f) === name).sort(byPosition);

  const core = inFolder(CORE_FOLDER).filter((f) => {
    const k = bareKey(f);
    return k !== 'activity_type' && !CORE_TYPE_SPECIFIC.has(k) && !MACHINE_FIELDS.has(k);
  });
  if (!def) return { core, typeFields: [], prominent: [], required: [] };

  const own = def.folder ? inFolder(def.folder) : [];
  const extras = (def.extraFields ?? [])
    .map((k) => all.find((f) => bareKey(f) === k))
    .filter((f): f is CustomFieldDef => Boolean(f));

  const pool = [...extras, ...own.filter((f) => !extras.some((e) => e.fieldKey === f.fieldKey))];
  const rank = (f: CustomFieldDef) => {
    const i = def.prominent.indexOf(bareKey(f));
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const typeFields = [...pool].sort((a, b) => rank(a) - rank(b) || byPosition(a, b));

  return {
    core,
    typeFields,
    prominent: typeFields.filter((f) => def.prominent.includes(bareKey(f))),
    required: def.required,
  };
}

/** What a client can be referred TO. Any mix — a person at an org, the org, and its directory entry. */
export type ReferredToKind = 'Contact' | 'Company' | 'Resource';

export interface ReferredTo {
  kind: ReferredToKind;
  recordId: string;
}

export interface ActivityInput {
  type: string;
  /**
   * The company that PARTICIPATED — required, and the thing reporting aggregates by.
   * Never the referral counterparty: those are separate associations (see `referredTo`), which is
   * why a service-provider company in the CRM can't inflate a "companies served" count.
   */
  companyId: string;
  /** Contacts who took part. May be empty (a company-level activity). */
  contactIds?: string[];
  /** Referral only: who/what the client was referred TO — contact, company, resource, or several. */
  referredTo?: ReferredTo[];
  /** Referral only, legacy shorthand for a single contact target. */
  referredToContactId?: string;
  /** bareKey → value, for core + this type's fields. */
  values: Record<string, unknown>;
}

/**
 * How the record is being written. The two modes have genuinely different completeness rules, and
 * conflating them is a bug in both directions:
 *
 *   'manual' — a person is filling in a form, so we can insist on a complete log and refuse the
 *              types that come from a GHL form instead.
 *   'ingest' — an adapter is recording something that ALREADY HAPPENED. Refusing it because a
 *              field the source doesn't carry is missing would silently drop a real interaction,
 *              which is far worse than an incomplete record. Only the structural rules apply.
 */
export type ActivityWriteMode = 'manual' | 'ingest';

/**
 * Is this input complete enough to write? Returns the reasons it isn't.
 *
 * The company check applies in BOTH modes and is deliberate: an activity with no company is
 * invisible to every funder report, which makes it worse than no record at all — someone believes
 * it was logged.
 */
export function validateActivityInput(
  input: ActivityInput,
  catalog: CustomFieldCatalog,
  mode: ActivityWriteMode = 'manual',
): string[] {
  const errors: string[] = [];
  const def = activityType(input.type);
  if (!def) {
    errors.push(`unknown activity_type "${input.type}" (expected one of ${ACTIVITY_TYPES.map((t) => t.key).join(', ')})`);
    return errors;
  }
  if (mode === 'manual' && !def.staffLogged) {
    errors.push(`"${def.label}" activities come from a GHL form, not staff entry`);
  }
  if (!input.companyId) errors.push('companyId is required — an activity with no company cannot be reported on');
  if (!input.values.activity_date) errors.push('activity_date is required');

  const set = activityFieldSet(catalog, input.type);
  const present = (k: string) => {
    const v = input.values[k];
    return v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
  };
  if (mode === 'manual') {
    for (const k of set.required) {
      if (!present(k)) {
        const label = set.typeFields.find((f) => bareKey(f) === k)?.name ?? k;
        errors.push(`${label} (${k}) is required for a ${def.label} activity`);
      }
    }
  }
  const targets = [...(input.referredTo ?? []), ...(input.referredToContactId ? [{ kind: 'Contact' as const, recordId: input.referredToContactId }] : [])];
  if (targets.length && input.type !== 'introduction_referral') {
    errors.push('a referred-to target only applies to an Introduction / Referral activity');
  }
  return errors;
}

/** Default `activity_name`: "<Type> – <Company> – <YYYY-MM-DD>" (sortable, and readable in GHL). */
export function defaultActivityName(type: string, companyName: string, date: unknown): string {
  const label = activityType(type)?.label ?? type;
  const day = String(date ?? '').slice(0, 10);
  return [label, companyName, day].filter(Boolean).join(' – ');
}
