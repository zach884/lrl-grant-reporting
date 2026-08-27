// lib/ghl/writeRecord.ts — object-agnostic WRITE of field changes to a GHL record.
//
// Dispatches per object, reusing the proven per-object coercion:
//   - contact     → PUT /contacts/{id}  (scalars + id-keyed customFields via coerceContact)
//   - business /  → PUT /objects/{key}/records/{id} { properties } (bare keys via coerceObject)
//     custom_objects.*
//   - opportunity → PUT /opportunities/{id} (scalars + id-keyed customFields)
// `changes` is { targetFieldKey: sourceValue }; coercion resolves to each target field's
// stored form. Never writes empty; skips unwritable/create-only fields (reported, not thrown).
// NOTE: the opportunity custom-field write payload shape is best-effort pending a live check.

import { GhlClient, ghl } from './client';
import { coerceObjectProperties, isUnwritable, isCreateOnly } from './coerce';
import { applyObjectWrite } from './objectWrite';
import { coerceContactCustomFields } from './coerceContact';
import { setContactCustomFields, setContactScalars, CONTACT_STD_SCALARS } from './contacts';
import type { CustomFieldCatalog } from './types';

export interface WriteResult {
  written: string[];
  skipped: Array<{ key: string; reason: string }>;
}

const CONTACT_SCALARS = new Set<string>(['firstName', 'lastName', 'name', 'email', 'phone', 'companyName', ...Array.from(CONTACT_STD_SCALARS)]);
const OPP_SCALARS = new Set<string>(['name', 'status', 'monetaryValue']);

const bare = (key: string, objectKey: string) => key.replace(new RegExp(`^${objectKey.replace('.', '\\.')}\\.`), '');

/**
 * `written`/`skipped` echo the CALLER'S key shape, always.
 *
 * Each writer below re-keys internally (contact scalars go bare, object properties go bare, custom
 * contact fields stay prefixed), so without this the result mixed both shapes — and the caller has no
 * way to know which it got. `lib/sync/apply.ts` then looked up `writeVals[k]` with the returned key
 * and got `undefined` for every object-record field, so the convergence guard's ledger stored an
 * EMPTY value under a bare key while the guard read a prefixed one. Measured 2026-08-27: 410 of 638
 * ledger rows held an empty value, which is to say the guard had never once been able to fire on the
 * company side. Echoing the input keys is what keeps that honest.
 */
function keyEchoer(changes: Record<string, unknown>, objectKey: string) {
  const byBare = new Map<string, string>();
  for (const k of Object.keys(changes)) byBare.set(bare(k, objectKey), k);
  return (k: string) => byBare.get(bare(k, objectKey)) ?? k;
}

async function writeContact(id: string, changes: Record<string, unknown>, catalog: CustomFieldCatalog, client: GhlClient): Promise<WriteResult> {
  const scalars: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(changes)) {
    if (CONTACT_SCALARS.has(bare(k, 'contact'))) scalars[bare(k, 'contact')] = v;
    else custom[k] = v;
  }
  const cc = coerceContactCustomFields(custom, catalog);
  if (cc.fields.length) await setContactCustomFields(id, cc.fields, client);
  if (Object.keys(scalars).length) await setContactScalars(id, scalars, client);
  const skippedKeys = new Set(cc.skipped.map((s) => s.key));
  const echo = keyEchoer(changes, 'contact');
  return {
    written: [...Object.keys(scalars), ...Object.keys(custom).filter((k) => !skippedKeys.has(k))].map(echo),
    skipped: cc.skipped.map((s) => ({ key: echo(s.key), reason: s.reason })),
  };
}

async function writeObjectRecord(objectKey: string, id: string, changes: Record<string, unknown>, catalog: CustomFieldCatalog, client: GhlClient, rawKeys: ReadonlySet<string>): Promise<WriteResult> {
  const skipped: WriteResult['skipped'] = [];
  const writable: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(changes)) {
    const def = catalog.byKey[`${objectKey}.${bare(k, objectKey)}`] ?? catalog.byKey[bare(k, objectKey)];
    if (def && (isUnwritable(def.dataType) || isCreateOnly(def.dataType))) {
      skipped.push({ key: k, reason: `unwritable/create-only (${def.dataType})` });
      continue;
    }
    writable[k] = v;
  }
  const coerced = coerceObjectProperties(objectKey, writable, catalog.byKey, 'update', rawKeys);
  // applyObjectWrite owns the modifier diff (MULTIPLE_OPTIONS / FILE_UPLOAD) + the read-back
  // verification, so `written` only ever contains fields GHL actually stored.
  const report = await applyObjectWrite(objectKey, id, coerced, catalog.byKey, client);
  const echo = keyEchoer(changes, objectKey);
  return {
    written: report.written.map(echo),
    skipped: [...skipped, ...report.skipped].map((s) => ({ ...s, key: echo(s.key) })),
  };
}

async function writeOpportunity(id: string, changes: Record<string, unknown>, catalog: CustomFieldCatalog, client: GhlClient): Promise<WriteResult> {
  const scalars: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(changes)) {
    if (OPP_SCALARS.has(bare(k, 'opportunity'))) scalars[bare(k, 'opportunity')] = v;
    else custom[k] = v;
  }
  const cc = coerceContactCustomFields(custom, catalog); // opportunities are id-keyed like contacts
  const body: Record<string, unknown> = { ...scalars };
  // Best-effort custom-field payload; verify/adjust against a live opportunity write.
  if (cc.fields.length) body.customFields = cc.fields.map((f) => ({ id: f.id, field_value: f.value }));
  if (Object.keys(body).length) await client.request({ method: 'PUT', path: `/opportunities/${id}`, autoLocation: false, body });
  const skippedKeys = new Set(cc.skipped.map((s) => s.key));
  const echo = keyEchoer(changes, 'opportunity');
  return {
    written: [...Object.keys(scalars), ...Object.keys(custom).filter((k) => !skippedKeys.has(k))].map(echo),
    skipped: cc.skipped.map((s) => ({ key: echo(s.key), reason: s.reason })),
  };
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();

/** Write `changes` (targetFieldKey → source value) to a record on any GHL object.
 *  `rawKeys` (bare keys) are written opaquely on the objects API — used for transformed values
 *  (e.g. countryCode) that must bypass option-label coercion. The contact-scalar path (where the
 *  only current transform, country, lands) writes verbatim already, so rawKeys is a no-op there. */
export function writeRecordFields(
  objectKey: string,
  recordId: string,
  changes: Record<string, unknown>,
  catalog: CustomFieldCatalog,
  client: GhlClient = ghl(),
  rawKeys: ReadonlySet<string> = EMPTY_KEYS,
): Promise<WriteResult> {
  if (Object.keys(changes).length === 0) return Promise.resolve({ written: [], skipped: [] });
  if (objectKey === 'contact') return writeContact(recordId, changes, catalog, client);
  if (objectKey === 'opportunity') return writeOpportunity(recordId, changes, catalog, client);
  return writeObjectRecord(objectKey, recordId, changes, catalog, client, rawKeys);
}
