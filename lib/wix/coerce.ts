// lib/wix/coerce.ts — coerce a GHL field value into a Wix column value.
//
// PURE (no I/O), like lib/ghl/coerce.ts. The two side-effecting cases — IMAGE (needs a
// Media Manager import) and (MULTI_)REFERENCE (needs label->item-id resolution + a
// reference write) — are returned as *intents* for the sync engine to execute. Everything
// else returns a plain value to place in the item body. Empty values are skipped (never
// overwrite Wix with blank), mirroring coerceBusinessProperties.

import { optionKeyToLabel, resolveOptionLabel } from '../ghl/coerce';
import type { GhlDataType, GhlFieldOption } from '../ghl/types';
import type { WixTransform } from '../mapping/wixTypes';
import type { WixFieldType } from './types';

/** GHL source type: a custom-field dataType, or 'scalar' for standard string fields. */
export type GhlSourceType = GhlDataType | 'scalar';

export type WixCoerceResult =
  | { kind: 'value'; value: unknown }
  | { kind: 'image'; sourceUrl: string; displayName?: string }
  | { kind: 'reference'; labels: string[] }
  | { kind: 'skip'; reason: string };

/** Wix column types that can't be written through the Data API item body. */
const UNWRITABLE_WIX_TYPES: ReadonlySet<string> = new Set(['PAGE_LINK']);

export function isUnwritableWixType(type: string, systemField?: boolean): boolean {
  return !!systemField || UNWRITABLE_WIX_TYPES.has(type);
}

function isEmpty(v: unknown): boolean {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** Extract a file URL from a GHL FILE_UPLOAD value (array of {url} objects or a raw url). */
function fileUrl(value: unknown): string | null {
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  if (Array.isArray(value) && value.length) {
    const first = value[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object' && typeof (first as any).url === 'string') return (first as any).url;
  }
  if (value && typeof value === 'object' && typeof (value as any).url === 'string') return (value as any).url;
  return null;
}

/** GHL option value (key/label, scalar or array or delimited) -> array of display LABELS. */
function toLabels(value: unknown, options?: GhlFieldOption[]): string[] {
  const raw = Array.isArray(value)
    ? value
    : String(value)
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean);
  const out: string[] = [];
  for (const v of raw) {
    const label = options ? resolveOptionLabel(v, options) ?? optionKeyToLabel(String(v), options) : String(v);
    if (label) out.push(String(label));
  }
  return out;
}

function normalizeUrl(v: string): string {
  const s = v.trim();
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

/**
 * Coerce one value. `ghlType`/`ghlOptions` describe the source; `wixType` the target column;
 * `transform` optionally forces a path (html / imageFromUpload / referenceFromOptions / etc.).
 */
export function coerceToWix(
  value: unknown,
  ghlType: GhlSourceType,
  wixType: WixFieldType | string,
  transform?: WixTransform,
  ghlOptions?: GhlFieldOption[],
): WixCoerceResult {
  if (isEmpty(value)) return { kind: 'skip', reason: 'empty' };

  // Reference targets → resolve labels downstream.
  if (wixType === 'REFERENCE' || wixType === 'MULTI_REFERENCE' || transform === 'referenceFromOptions') {
    const labels = toLabels(value, ghlOptions);
    return labels.length ? { kind: 'reference', labels } : { kind: 'skip', reason: 'no reference labels' };
  }

  // Image targets → import the source file downstream.
  if (wixType === 'IMAGE' || transform === 'imageFromUpload') {
    const url = fileUrl(value);
    return url ? { kind: 'image', sourceUrl: url } : { kind: 'skip', reason: 'no file url' };
  }

  switch (wixType) {
    case 'RICH_TEXT':
    case 'RICH_CONTENT': {
      const text = String(value);
      return { kind: 'value', value: transform === 'html' || !/<[a-z]/i.test(text) ? `<p>${text}</p>` : text };
    }
    case 'NUMBER': {
      const n = Number(value);
      return Number.isFinite(n) ? { kind: 'value', value: n } : { kind: 'skip', reason: 'not a number' };
    }
    case 'ARRAY_STRING': {
      const arr = Array.isArray(value)
        ? value.map((v) => String(v))
        : toLabels(value, ghlOptions);
      return arr.length ? { kind: 'value', value: arr } : { kind: 'skip', reason: 'empty array' };
    }
    case 'DATE':
    case 'DATETIME': {
      const d = String(value);
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00Z` : d;
      return { kind: 'value', value: { $date: iso } };
    }
    case 'BOOLEAN':
      return { kind: 'value', value: value === true || value === 'true' || value === 1 };
    case 'URL':
      return { kind: 'value', value: normalizeUrl(String(value)) };
    default: {
      // TEXT / EMAIL / and anything else: option types resolve to their label, else string.
      if ((ghlType === 'SINGLE_OPTIONS' || ghlType === 'RADIO') && ghlOptions) {
        const label = resolveOptionLabel(value, ghlOptions);
        return { kind: 'value', value: label ?? String(value) };
      }
      return { kind: 'value', value: String(value).trim() };
    }
  }
}
