// lib/ghl/coerce.ts — the confirmed GHL field-write / read rules, as pure functions.
//
// These rules were proven live (see the `ghl-company-object-api-facts` memory and the
// reusable /scripts). Getting them wrong = silent data loss, so they live in one place,
// are unit-tested, and every write path goes through them.
//
// WRITE rules (business object, PUT /objects/business/records/{id} body {properties:{bareKey:val}}):
//   - NUMERICAL: must be an int (not a string).
//   - SINGLE_OPTIONS / RADIO: send the option LABEL; GHL stores + reads back the KEY.
//   - DATE: a date-only string ("2026-06-29") returns 200 but is SILENTLY DROPPED.
//     Send full ISO datetime ("2026-06-29T00:00:00Z"). Reads back as YYYY-MM-DD.
//   - MULTIPLE_OPTIONS: at CREATE, value = array of option KEYS in `properties`.
//     On UPDATE it needs a MODIFIER object, not a value (corrected 2026-08-17):
//       { properties: { <bareKey>: { add: [optionKeys], remove: [optionKeys] } } }
//     The 2026-07-07 "immutable via update" conclusion was a measurement error — we had
//     only ever sent *values*. Verified live on business + custom_objects.*: add/remove
//     both work and are dupe-safe; there is NO set/replace modifier; a plain array 422s;
//     and *** a plain string returns 200 and WIPES the field to null *** (this silently
//     destroyed resource stop values from 2026-07-30 to 08-17). So: emit a modifier
//     intent on update and NEVER fall through to a plain string/array.
//     Option KEYS only — a label in `add` returns 200 and is a silent no-op.
//   - FILE_UPLOAD on objects: same modifier family, { add: [{url}] } (no `meta` — including
//     it 422s). A plain string stores null. Verified live on resources.resource_logo.
//   - CHECKBOX: same modifier contract as MULTIPLE_OPTIONS (re-probed live 2026-08-17 —
//     {add,remove} persists; a plain array 422s; a plain string 200s and stores null).
//     It was wrongly listed as unwritable from the same 2026-07-07 measurement error.
//   - TEXTBOX_LIST: still refused. NOT re-probed with the modifier shape (no field of that type
//     exists on this location), so this is unverified rather than proven.
//
// READ rules:
//   - SINGLE_OPTIONS read back as the option KEY -> map to LABEL for display.
//   - Contact single-select stored labels can DRIFT from the field's own option labels
//     (e.g. "III-D" vs "III - D") -> normalize on the way in.

import { CustomFieldDef, GhlDataType, GhlFieldOption } from './types';
import { GhlUnwritableFieldError } from './errors';
import { fileUrls } from './fileValue';

export type WriteMode = 'create' | 'update';

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Field types GHL silently drops / rejects on write via the API in ALL modes.
 *
 * CHECKBOX left this set on 2026-08-17: probed live with every shape
 * (scripts-ts/probe-checkbox-writability.ts) and the `{add,remove}` modifier persists on the
 * business object, exactly like MULTIPLE_OPTIONS. Same measurement error, same fix.
 * TEXTBOX_LIST stays — but note it is UNPROBED with the modifier shape (no field of that type
 * exists on this location to probe against), so treat it as unverified rather than proven.
 */
export const UNWRITABLE_TYPES: ReadonlySet<GhlDataType> = new Set<GhlDataType>([
  'TEXTBOX_LIST',
]);

/**
 * Types writable only when a record is CREATED (immutable via update afterward).
 *
 * EMPTY since 2026-08-17. `MULTIPLE_OPTIONS` used to live here on the strength of the
 * 2026-07-07 live test, but that test only ever sent *values*; the update API wants a
 * modifier object (see the header). Nothing is create-only today. Kept as an extension
 * point — and because `isCreateOnly` gates four separate write paths (writeRecord,
 * mapping/resolve, enrichment/engine, dedup/engine).
 */
export const CREATE_ONLY_TYPES: ReadonlySet<GhlDataType> = new Set<GhlDataType>([]);

/**
 * Types whose UPDATE payload is a MODIFIER object (`{add,remove}`) rather than a value.
 * These must never be placed in `properties` as a bare value on update — a plain array
 * 422s and a plain string silently nulls the field.
 */
export const MODIFIER_TYPES: ReadonlySet<GhlDataType> = new Set<GhlDataType>([
  'MULTIPLE_OPTIONS',
  'CHECKBOX',
  'FILE_UPLOAD',
]);

/** True if the field can never be written via the API (any mode). */
export function isUnwritable(dataType: GhlDataType): boolean {
  return UNWRITABLE_TYPES.has(dataType);
}

/** True if the field can be set only at create time, not on update. */
export function isCreateOnly(dataType: GhlDataType): boolean {
  return CREATE_ONLY_TYPES.has(dataType);
}

/** True if updating this field requires an `{add,remove}` modifier instead of a value. */
export function isModifierType(dataType: GhlDataType): boolean {
  return MODIFIER_TYPES.has(dataType);
}

/** Is this field writable at all in the given mode? */
export function isWritableInMode(dataType: GhlDataType, mode: WriteMode): boolean {
  if (isUnwritable(dataType)) return false;
  if (isCreateOnly(dataType)) return mode === 'create';
  return true;
}

/** Resolve a single value to its option KEY (multi-select stores + reads keys). */
export function resolveOptionKey(
  value: unknown,
  options: GhlFieldOption[] | undefined,
): string | null {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!options || options.length === 0) return s;
  const byKey = options.find((o) => o.key === s);
  if (byKey) return byKey.key;
  const byLabel = options.find((o) => o.label === s);
  if (byLabel) return byLabel.key;
  const n = normalizeToken(s);
  const fuzzy = options.find((o) => normalizeToken(o.key) === n || normalizeToken(o.label) === n);
  return fuzzy ? fuzzy.key : null;
}

/** Resolve a scalar-or-array multi-select input to an array of option KEYS. */
export function resolveOptionKeys(
  value: unknown,
  options: GhlFieldOption[] | undefined,
): string[] {
  const arr = Array.isArray(value) ? value : String(value).split(/[,;]/);
  const keys: string[] = [];
  for (const v of arr) {
    const k = resolveOptionKey(typeof v === 'string' ? v.trim() : v, options);
    if (k && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Turn a date-only string into the full-ISO form GHL actually persists. */
export function toGhlDate(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value).trim();
  if (DATE_ONLY.test(s)) return `${s}T00:00:00Z`;
  // Already a datetime, epoch, or other — pass through as string.
  return s;
}

/** Normalize a raw label/key so it matches an option regardless of spacing/case drift. */
function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '').replace(/[_-]+/g, '');
}

/**
 * Resolve a caller-supplied single-select value (which may be a label, a key, or a
 * drifted label) to the exact option LABEL to send on write. Returns null if the value
 * can't be matched to any option (caller should skip rather than send garbage).
 */
export function resolveOptionLabel(
  value: unknown,
  options: GhlFieldOption[] | undefined,
): string | null {
  if (value == null || value === '') return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!options || options.length === 0) return s; // no catalog to validate against
  // Exact label, exact key, then fuzzy (drift-tolerant) on both.
  const byLabel = options.find((o) => o.label === s);
  if (byLabel) return byLabel.label;
  const byKey = options.find((o) => o.key === s);
  if (byKey) return byKey.label;
  const n = normalizeToken(s);
  const fuzzy = options.find(
    (o) => normalizeToken(o.label) === n || normalizeToken(o.key) === n,
  );
  return fuzzy ? fuzzy.label : null;
}

/** Map a stored single-select KEY back to its display LABEL (read path). */
export function optionKeyToLabel(
  key: unknown,
  options: GhlFieldOption[] | undefined,
): string | null {
  if (key == null || key === '') return null;
  const s = String(key).trim();
  if (!options || options.length === 0) return s;
  const hit = options.find((o) => o.key === s) ?? options.find((o) => o.label === s);
  return hit ? hit.label : s;
}

/**
 * A field whose update payload is an `{add,remove}` modifier. Coercion resolves the DESIRED
 * end state; the writer diffs it against the record's current value to build add/remove
 * (it can't be done here — this module is pure and has never read the record).
 */
export interface ModifierIntent {
  /** 'options' -> desired is option KEYS · 'files' -> desired is file URLs. */
  kind: 'options' | 'files';
  desired: string[];
}

export interface CoerceResult {
  /** bareKey -> coerced value, ready to nest under { properties }. */
  properties: Record<string, unknown>;
  /**
   * bareKey -> desired end state for a modifier-typed field (update mode only). The writer
   * MUST diff these and send `{add,remove}`; putting the value in `properties` instead is a
   * silent-data-loss bug (plain string) or a 422 (plain array).
   */
  modifiers: Record<string, ModifierIntent>;
  /** Inputs skipped because the value didn't resolve (e.g. unknown option). */
  skipped: Array<{ key: string; value: unknown; reason: string }>;
}

/**
 * Coerce a map of { fieldKey|bareKey: value } into a writable `properties` object,
 * applying every rule above. `fieldKey` may be "business.foo" or bare "foo".
 * `mode` defaults to 'update' (the common path). Pass 'create' when building the body
 * for POST /objects/business/records so MULTIPLE_OPTIONS fields are allowed.
 * Throws GhlUnwritableFieldError for CHECKBOX/TEXTBOX_LIST (any mode) and for
 * MULTIPLE_OPTIONS on update.
 */
export function coerceBusinessProperties(
  values: Record<string, unknown>,
  catalogByKey: Record<string, CustomFieldDef>,
  mode: WriteMode = 'update',
  rawKeys: ReadonlySet<string> = EMPTY_SET,
): CoerceResult {
  return coerceObjectProperties('business', values, catalogByKey, mode, rawKeys);
}

/**
 * Object-agnostic version of the above — coerces { fieldKey|bareKey: value } into a writable
 * `properties` object for any objects-API object (business, custom_objects.*). `fieldKey` may be
 * "<objectKey>.foo" or bare "foo". Same rules/writability as the business path.
 */
export function coerceObjectProperties(
  objectKey: string,
  values: Record<string, unknown>,
  catalogByKey: Record<string, CustomFieldDef>,
  mode: WriteMode = 'update',
  rawKeys: ReadonlySet<string> = EMPTY_SET,
): CoerceResult {
  const properties: Record<string, unknown> = {};
  const modifiers: CoerceResult['modifiers'] = {};
  const skipped: CoerceResult['skipped'] = [];
  const prefix = `${objectKey}.`;

  for (const [inputKey, rawValue] of Object.entries(values)) {
    if (rawValue == null || rawValue === '' || (Array.isArray(rawValue) && rawValue.length === 0)) {
      continue; // never overwrite with empty
    }
    const bareKey = inputKey.startsWith(prefix) ? inputKey.slice(prefix.length) : inputKey;
    // Opaque pass-through (e.g. country ISO code): store the value as a trimmed string,
    // bypassing this field's option/date/number coercion.
    if (rawKeys.has(bareKey)) {
      properties[bareKey] = String(rawValue).trim();
      continue;
    }
    const def = catalogByKey[`${objectKey}.${bareKey}`] ?? catalogByKey[bareKey];
    const dataType = def?.dataType;

    if (dataType && isUnwritable(dataType)) {
      throw new GhlUnwritableFieldError(`${objectKey}.${bareKey}`, dataType);
    }
    if (dataType && isCreateOnly(dataType) && mode !== 'create') {
      throw new GhlUnwritableFieldError(
        `${objectKey}.${bareKey}`,
        dataType,
        `is settable only at record creation (POST /objects/${objectKey}/records with an array of ` +
          `option keys). It is immutable via update — set it at creation, or maintain in the UI.`,
      );
    }

    switch (dataType) {
      case 'MULTIPLE_OPTIONS':
      case 'CHECKBOX': {
        // Same contract on both (CHECKBOX verified live 2026-08-17): option KEYS, modifier on update.
        const keys = resolveOptionKeys(rawValue, def?.options);
        if (keys.length === 0) {
          skipped.push({ key: bareKey, value: rawValue, reason: 'no matching options' });
          continue;
        }
        // CREATE: a plain array of option keys in `properties` is correct and proven.
        // UPDATE: must be a modifier — hand the desired key set to the writer to diff.
        if (mode === 'create') properties[bareKey] = keys;
        else modifiers[bareKey] = { kind: 'options', desired: keys };
        break;
      }
      case 'FILE_UPLOAD': {
        const urls = fileUrls(rawValue);
        if (urls.length === 0) {
          skipped.push({ key: bareKey, value: rawValue, reason: 'no file url' });
          continue;
        }
        if (mode === 'create') {
          // Untested at create (POST). Skip rather than guess: the old behaviour fell through
          // to String(value), which stored garbage. Files are attached on update today.
          skipped.push({ key: bareKey, value: rawValue, reason: 'FILE_UPLOAD at create not verified — set it on update' });
          continue;
        }
        modifiers[bareKey] = { kind: 'files', desired: urls };
        break;
      }
      case 'NUMERICAL': {
        const n = Number(rawValue);
        if (!Number.isFinite(n)) {
          skipped.push({ key: bareKey, value: rawValue, reason: 'not a number' });
          continue;
        }
        properties[bareKey] = Math.trunc(n);
        break;
      }
      case 'DATE': {
        const iso = toGhlDate(rawValue);
        if (iso == null) {
          skipped.push({ key: bareKey, value: rawValue, reason: 'unparseable date' });
          continue;
        }
        properties[bareKey] = iso;
        break;
      }
      case 'SINGLE_OPTIONS':
      case 'RADIO': {
        const label = resolveOptionLabel(rawValue, def?.options);
        if (label == null) {
          skipped.push({ key: bareKey, value: rawValue, reason: 'no matching option' });
          continue;
        }
        properties[bareKey] = label;
        break;
      }
      default: {
        // TEXT / LARGE_TEXT / PHONE / EMAIL / unknown -> string.
        properties[bareKey] = typeof rawValue === 'string' ? rawValue : String(rawValue);
      }
    }
  }

  return { properties, modifiers, skipped };
}
