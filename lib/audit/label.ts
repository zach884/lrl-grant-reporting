// lib/audit/label.ts — turn a record id into something a human recognises, for the change log.
//
// The log was recording WHAT changed but not WHO it happened to. Three different behaviours had
// grown up side by side (observed on live data 2026-08-18):
//
//   contact-enrichers      "update contact · Emmett Barrett"        ← right
//   wix:Contact → Team     "· xlKPrl2Wf1KHy44NxClf"                 ← the GHL id, not a name
//   contact-to-company     "update business" + record: 6a7634e18…   ← no label at all
//
// So reviewing a night's writes meant pasting ids into GHL one at a time. This resolves a label per
// object type, and the log call sites pass it in.
//
// Caching matters: a single webhook can log several events for the same record, and a batch sweep
// logs hundreds. Lookups are memoised for CACHE_TTL_MS so a run costs at most one read per record —
// and misses are cached too, so a deleted record doesn't get retried on every event.

import type { GhlClient } from '../ghl/client';

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { label: string | undefined; at: number }>();

/** Longest sensible label; the log UI truncates anyway and a stray bio would be unreadable. */
const MAX_LEN = 120;

function clean(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length > MAX_LEN ? `${s.slice(0, MAX_LEN - 1)}…` : s;
}

/**
 * The field most likely to hold a custom object's display name.
 *
 * GHL custom objects conventionally name their primary text field after the object itself
 * (`custom_objects.resources` → `resources`), which is the case here. `name`/`title` are tried as
 * fallbacks so a new object works without a code change.
 */
function customObjectNameKeys(objectKey: string): string[] {
  const bare = objectKey.replace(/^custom_objects\./, '');
  return [bare, 'name', 'title', `${bare}_name`];
}

/** Resolve a label from an ALREADY-READ record, with no further I/O. Prefer this where possible. */
export function labelFromFields(
  objectKey: string,
  get: (key: string) => unknown,
): string | undefined {
  if (objectKey === 'contact') {
    const full = [get('firstName'), get('lastName')].map(clean).filter(Boolean).join(' ');
    return clean(full) ?? clean(get('email')) ?? clean(get('companyName'));
  }
  if (objectKey === 'business') return clean(get('name')) ?? clean(get('business.name'));
  if (objectKey === 'opportunity') return clean(get('name'));
  for (const k of customObjectNameKeys(objectKey)) {
    const v = clean(get(k)) ?? clean(get(`${objectKey}.${k}`));
    if (v) return v;
  }
  return undefined;
}

/**
 * Resolve a label by reading the record. Memoised, and NEVER throws — a log line is not worth
 * failing a sync over, so an unresolvable record just gets no label (the id is still recorded).
 */
export async function resolveRecordLabel(
  objectKey: string,
  recordId: string,
  client?: GhlClient,
): Promise<string | undefined> {
  if (!recordId) return undefined;
  const key = `${objectKey}:${recordId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.label;

  let label: string | undefined;
  try {
    const { readRecordFields } = await import('../ghl/records');
    const fields = await readRecordFields(objectKey, recordId, client);
    label = labelFromFields(objectKey, (k) => fields.get(k));
  } catch {
    label = undefined; // cached below so a missing record isn't re-read per event
  }
  cache.set(key, { label, at: Date.now() });
  return label;
}

/** Drop memoised labels (tests, and after a rename batch). */
export function clearLabelCache(): void {
  cache.clear();
}
