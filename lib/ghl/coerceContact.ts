// lib/ghl/coerceContact.ts — shape values for CONTACT custom-field writes.
//
// Contacts are where the app writes DOWN-sync values (company is source of truth, edited
// natively / at create; app fans out to associated contacts). Every write goes through
// PUT /contacts/{id} body { customFields: [{ id, value }] }. Each data type needs a
// specific value shape — confirmed live 2026-07-07:
//   - MULTIPLE_OPTIONS: array of EXACT option LABELS (total overwrite).
//   - TEXTBOX_LIST: OBJECT keyed by row picklistOption id -> { rowId: text }.
//   - FILE_UPLOAD: array of URL strings (or [{url,meta}]); see files upload flow.
//   - SINGLE_OPTIONS / RADIO: option LABEL string.
//   - DATE: YYYY-MM-DD (contacts accept date-only). NUMERICAL: number. else: string.

import { CustomFieldCatalog, CustomFieldDef } from './types';
import { resolveOptionLabel } from './coerce';

export interface ContactFieldWrite {
  id: string;
  value: unknown;
}

export interface ContactCoerceResult {
  fields: ContactFieldWrite[];
  skipped: Array<{ key: string; value: unknown; reason: string }>;
}

/** Map a TEXTBOX_LIST input to the stored object form { rowId: text }. */
export function toTextboxListValue(
  value: unknown,
  rows: CustomFieldDef['rows'],
): Record<string, string> | null {
  if (value == null || value === '') return null;
  // Already keyed by row id?
  if (!Array.isArray(value) && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v == null || v === '') continue;
      const row = rows?.find((r) => r.id === k || r.label === k);
      out[row ? row.id : k] = String(v);
    }
    return Object.keys(out).length ? out : null;
  }
  // Array of plain strings -> fill rows positionally.
  if (Array.isArray(value) && rows && rows.length) {
    const out: Record<string, string> = {};
    value.slice(0, rows.length).forEach((v, i) => {
      if (v != null && v !== '') out[rows[i].id] = String(v);
    });
    return Object.keys(out).length ? out : null;
  }
  return null;
}

/**
 * Coerce a { fieldKey|id: value } map into contact customFields write entries.
 * `catalog` supplies dataType + options + rows per field.
 */
export function coerceContactCustomFields(
  values: Record<string, unknown>,
  catalog: CustomFieldCatalog,
): ContactCoerceResult {
  const fields: ContactFieldWrite[] = [];
  const skipped: ContactCoerceResult['skipped'] = [];

  for (const [inputKey, raw] of Object.entries(values)) {
    if (raw == null || raw === '' || (Array.isArray(raw) && raw.length === 0)) continue;
    const def = catalog.byKey[inputKey] ?? catalog.byId[inputKey];
    if (!def) {
      skipped.push({ key: inputKey, value: raw, reason: 'field not in catalog' });
      continue;
    }
    switch (def.dataType) {
      case 'MULTIPLE_OPTIONS': {
        const arr = Array.isArray(raw) ? raw : String(raw).split(/[,;]/).map((s) => s.trim());
        const labels = arr
          .map((v) => resolveOptionLabel(v, def.options))
          .filter((l): l is string => !!l);
        if (labels.length === 0) { skipped.push({ key: inputKey, value: raw, reason: 'no matching options' }); break; }
        fields.push({ id: def.id, value: labels });
        break;
      }
      case 'TEXTBOX_LIST': {
        const obj = toTextboxListValue(raw, def.rows);
        if (!obj) { skipped.push({ key: inputKey, value: raw, reason: 'unresolvable textbox-list rows' }); break; }
        fields.push({ id: def.id, value: obj });
        break;
      }
      case 'FILE_UPLOAD': {
        const urls = Array.isArray(raw) ? raw : [raw];
        fields.push({ id: def.id, value: urls });
        break;
      }
      case 'SINGLE_OPTIONS':
      case 'RADIO': {
        const label = resolveOptionLabel(raw, def.options);
        if (label == null) { skipped.push({ key: inputKey, value: raw, reason: 'no matching option' }); break; }
        fields.push({ id: def.id, value: label });
        break;
      }
      case 'NUMERICAL': {
        const n = Number(raw);
        if (!Number.isFinite(n)) { skipped.push({ key: inputKey, value: raw, reason: 'not a number' }); break; }
        fields.push({ id: def.id, value: n });
        break;
      }
      default:
        fields.push({ id: def.id, value: typeof raw === 'string' ? raw : String(raw) });
    }
  }
  return { fields, skipped };
}
