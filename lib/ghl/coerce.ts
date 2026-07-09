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
//   - MULTIPLE_OPTIONS: settable ONLY at record CREATE (POST /objects/business/records,
//     value = array of option KEYS). Confirmed live 2026-07-07: on UPDATE, PUT returns
//     422 "unexpected format" for every shape and PATCH is not allowed -> immutable via
//     the API after creation. So we accept it in 'create' mode, refuse it in 'update' mode.
//   - CHECKBOX / TEXTBOX_LIST: WILL NOT persist via API in any mode -> refuse.
//
// READ rules:
//   - SINGLE_OPTIONS read back as the option KEY -> map to LABEL for display.
//   - Contact single-select stored labels can DRIFT from the field's own option labels
//     (e.g. "III-D" vs "III - D") -> normalize on the way in.

import { CustomFieldDef, GhlDataType, GhlFieldOption } from './types';
import { GhlUnwritableFieldError } from './errors';

export type WriteMode = 'create' | 'update';

const EMPTY_SET: ReadonlySet<string> = new Set();

/** Field types GHL silently drops / rejects on write via the API in ALL modes. */
export const UNWRITABLE_TYPES: ReadonlySet<GhlDataType> = new Set<GhlDataType>([
  'CHECKBOX',
  'TEXTBOX_LIST',
]);

/** Types writable only when a record is CREATED (immutable via update afterward). */
export const CREATE_ONLY_TYPES: ReadonlySet<GhlDataType> = new Set<GhlDataType>([
  'MULTIPLE_OPTIONS',
]);

/** True if the field can never be written via the API (any mode). */
export function isUnwritable(dataType: GhlDataType): boolean {
  return UNWRITABLE_TYPES.has(dataType);
}

/** True if the field can be set only at create time, not on update. */
export function isCreateOnly(dataType: GhlDataType): boolean {
  return CREATE_ONLY_TYPES.has(dataType);
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

export interface CoerceResult {
  /** bareKey -> coerced value, ready to nest under { properties }. */
  properties: Record<string, unknown>;
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
  const properties: Record<string, unknown> = {};
  const skipped: CoerceResult['skipped'] = [];

  for (const [inputKey, rawValue] of Object.entries(values)) {
    if (rawValue == null || rawValue === '' || (Array.isArray(rawValue) && rawValue.length === 0)) {
      continue; // never overwrite with empty
    }
    const bareKey = inputKey.startsWith('business.') ? inputKey.slice('business.'.length) : inputKey;
    // Opaque pass-through (e.g. country ISO code): store the value as a trimmed string,
    // bypassing this field's option/date/number coercion. Used for SINGLE_OPTIONS fields
    // whose value is really an external code we sync verbatim from the contact side.
    if (rawKeys.has(bareKey)) {
      properties[bareKey] = String(rawValue).trim();
      continue;
    }
    const def = catalogByKey[`business.${bareKey}`] ?? catalogByKey[bareKey];
    const dataType = def?.dataType;

    if (dataType && isUnwritable(dataType)) {
      throw new GhlUnwritableFieldError(`business.${bareKey}`, dataType);
    }
    if (dataType && isCreateOnly(dataType) && mode !== 'create') {
      throw new GhlUnwritableFieldError(
        `business.${bareKey}`,
        dataType,
        `is settable only at record creation (POST /objects/business/records with an array of ` +
          `option keys). It is immutable via update — set it when the company is created, or maintain in the UI.`,
      );
    }

    switch (dataType) {
      case 'MULTIPLE_OPTIONS': {
        // create-mode only (guarded above): array of option KEYS.
        const keys = resolveOptionKeys(rawValue, def?.options);
        if (keys.length === 0) {
          skipped.push({ key: bareKey, value: rawValue, reason: 'no matching options' });
          continue;
        }
        properties[bareKey] = keys;
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

  return { properties, skipped };
}
