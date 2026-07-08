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
//   - CHECKBOX / TEXTBOX_LIST / MULTIPLE_OPTIONS: WILL NOT persist via API -> refuse.
//
// READ rules:
//   - SINGLE_OPTIONS read back as the option KEY -> map to LABEL for display.
//   - Contact single-select stored labels can DRIFT from the field's own option labels
//     (e.g. "III-D" vs "III - D") -> normalize on the way in.

import { CustomFieldDef, GhlDataType, GhlFieldOption } from './types';
import { GhlUnwritableFieldError } from './errors';

/** Field types that GHL silently drops on write via the API. */
export const UNWRITABLE_TYPES: ReadonlySet<GhlDataType> = new Set<GhlDataType>([
  'CHECKBOX',
  'TEXTBOX_LIST',
  'MULTIPLE_OPTIONS',
]);

export function isUnwritable(dataType: GhlDataType): boolean {
  return UNWRITABLE_TYPES.has(dataType);
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
 * Throws GhlUnwritableFieldError if asked to write a CHECKBOX/TEXTBOX_LIST/MULTIPLE_OPTIONS.
 */
export function coerceBusinessProperties(
  values: Record<string, unknown>,
  catalogByKey: Record<string, CustomFieldDef>,
): CoerceResult {
  const properties: Record<string, unknown> = {};
  const skipped: CoerceResult['skipped'] = [];

  for (const [inputKey, rawValue] of Object.entries(values)) {
    if (rawValue == null || rawValue === '' || (Array.isArray(rawValue) && rawValue.length === 0)) {
      continue; // never overwrite with empty
    }
    const bareKey = inputKey.startsWith('business.') ? inputKey.slice('business.'.length) : inputKey;
    const def = catalogByKey[`business.${bareKey}`] ?? catalogByKey[bareKey];
    const dataType = def?.dataType;

    if (dataType && isUnwritable(dataType)) {
      throw new GhlUnwritableFieldError(`business.${bareKey}`, dataType);
    }

    switch (dataType) {
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
