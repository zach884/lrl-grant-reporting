// lib/ghl/createRecord.ts — the ONE creator for objects-API records (custom_objects.*, business).
//
// The counterpart to objectWrite.applyObjectWrite, which only updates. Create differs from update
// in exactly one way that matters, and it is the opposite of the rule everyone remembers:
//
//   • On UPDATE, a MULTIPLE_OPTIONS field needs an {add,remove} MODIFIER — a plain array 422s and a
//     plain string silently nulls the field.
//   • On CREATE, a plain array of option KEYS is correct and is the ONLY way to set those fields at
//     all (they are effectively immutable afterwards on some field types).
//
// `coerceObjectProperties(..., 'create')` already encodes that difference, so this function's job is
// the other half of the contract we learned the hard way: **read the record back and verify**. GHL
// accepts writes it does not store, and at create that failure is worse than on update — the record
// exists, so nothing looks wrong, but the field is empty forever.
//
// FILE_UPLOAD at create is deliberately skipped by the coercer (unverified shape); attach files with
// an update after the record exists.

import { GhlClient, ghl } from './client';
import { coerceObjectProperties } from './coerce';
import type { CoerceResult } from './coerce';
import { didPersist } from './objectWrite';
import type { CustomFieldDef } from './types';

export interface ObjectCreateReport {
  /** The new record's id. */
  recordId: string;
  /** Fields sent AND verified as stored. */
  written: string[];
  /** Fields not sent, or sent and found not to have persisted. */
  skipped: Array<{ key: string; reason: string }>;
  /** The coercion result, so callers can report the offending input value. */
  coerced: CoerceResult;
}

/**
 * Create one record on an objects-API object, then verify what landed.
 *
 * `values` is { fieldKey|bareKey: value }; coercion resolves each to its field's write form
 * (option keys, full-ISO dates, truncated numbers). Throws only when the POST itself fails —
 * a field that didn't persist comes back in `skipped`, never as a silent success.
 *
 * Pass `verify: false` only when the caller re-reads the record itself.
 */
export async function createObjectRecord(
  objectKey: string,
  values: Record<string, unknown>,
  catalogByKey: Record<string, CustomFieldDef>,
  client: GhlClient = ghl(),
  opts: { verify?: boolean } = {},
): Promise<ObjectCreateReport> {
  const coerced = coerceObjectProperties(objectKey, values, catalogByKey, 'create');
  const skipped: ObjectCreateReport['skipped'] = coerced.skipped.map((s) => ({ key: s.key, reason: s.reason }));

  // Modifier intents are an UPDATE-mode concept; in create mode the coercer puts option arrays
  // straight into `properties`. Anything landing here (FILE_UPLOAD) can't be set at create.
  for (const key of Object.keys(coerced.modifiers)) {
    skipped.push({ key, reason: 'not settable at create — attach it with an update' });
  }

  const data = await client.request<any>({
    method: 'POST',
    path: `/objects/${objectKey}/records`,
    autoLocation: false,
    body: { locationId: client.locationId, properties: coerced.properties },
  });
  const recordId: string = data.record?.id ?? data.id;
  if (!recordId) throw new Error(`create on ${objectKey} returned no record id: ${JSON.stringify(data).slice(0, 300)}`);

  const sentKeys = Object.keys(coerced.properties);
  if (opts.verify === false || sentKeys.length === 0) {
    return { recordId, written: sentKeys, skipped, coerced };
  }

  // Read back: report only what GHL actually stored as written.
  let after: Record<string, unknown>;
  try {
    const read = await client.request<any>({ path: `/objects/${objectKey}/records/${recordId}` });
    after = ((read.record ?? read)?.properties ?? {}) as Record<string, unknown>;
  } catch (e: any) {
    return {
      recordId,
      written: [],
      skipped: [...skipped, ...sentKeys.map((key) => ({ key, reason: `created but unverified (read-back failed: ${e?.message ?? e})` }))],
      coerced,
    };
  }

  const written: string[] = [];
  for (const key of sentKeys) {
    const def = catalogByKey[`${objectKey}.${key}`] ?? catalogByKey[key];
    const ok = didPersist(def?.dataType, coerced.properties[key], after[key], def);
    if (ok === false) {
      skipped.push({ key, reason: `did not persist (GHL returned 200; stored ${JSON.stringify(after[key] ?? null)})` });
    } else {
      written.push(key);
    }
  }

  return { recordId, written, skipped, coerced };
}

/** Delete an objects-API record. Used by the activity delete route and by live test cleanup. */
export async function deleteObjectRecord(objectKey: string, recordId: string, client: GhlClient = ghl()): Promise<void> {
  await client.request({ method: 'DELETE', path: `/objects/${objectKey}/records/${recordId}`, autoLocation: false });
}
