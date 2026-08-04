// lib/sync/dryrun.ts — read-only "what would this connection write?" for an arbitrary GHL↔GHL
// object pair, traversing a chosen association. NO writes. Kept separate from the live
// contact↔company engine (lib/sync/{up,down}sync.ts) so that proven path is untouched.
//
// Flow: read the source record's fields -> getRelations(sourceId, associationId) -> the
// counterpart record ids on the target object -> re-read each counterpart in full -> per
// mapping row, coerce the source value toward the target field and diff against the
// counterpart's current value. Direction: rows that push source->target (up | both).

import { resolveCounterpartIds } from './traverse';
import { readRecordFields } from '../ghl/records';
import { getCatalog } from '../ghl/catalogCache';
import { resolveOptionKey, resolveOptionKeys, resolveOptionLabel, optionKeyToLabel, toGhlDate } from '../ghl/coerce';
import type { CustomFieldCatalog, CustomFieldDef } from '../ghl/types';
import type { GhlClient } from '../ghl/client';

export interface DryRunRow {
  sourceKey: string;
  targetKey: string;
  direction: 'up' | 'down' | 'both';
  /** Optional per-row value transform (e.g. 'countryCode'). Applied to the source value. */
  transform?: string;
  /** Tri-state (undefined ⇒ enabled). A disabled row is never synced — matches the built-in
   *  engine's `enabled !== false` gate; without this the generic engine would write fields the
   *  user turned off. */
  enabled?: boolean;
  /** No-downgrade guard: never overwrite an EXISTING (non-blank) target value with one of these
   *  values. Mirrors the built-in engine's hold logic (e.g. don't clobber a real county with "Other"). */
  holdValues?: string[];
}
export interface DryRunConnection {
  sourceObject: string;
  targetObject: string;
  associationId: string;
  rows: DryRunRow[];
  /** Human/slug name of the connection, for change-log attribution (e.g. 'contact-to-company'). */
  name?: string;
}

export interface DryRunChange { sourceKey: string; targetKey: string; from: unknown; to: unknown }
export interface DryRunCounterpart {
  targetId: string;
  changes: DryRunChange[];
  unchanged: number;
  skipped: { targetKey: string; reason: string }[];
}
export interface ConnectionDryRun {
  sourceObject: string;
  targetObject: string;
  associationId: string;
  sourceRecordId: string;
  counterpartCount: number;
  counterparts: DryRunCounterpart[];
  note?: string;
}

const isOption = (def?: CustomFieldDef) => def?.dataType === 'SINGLE_OPTIONS' || def?.dataType === 'RADIO';
const isMulti = (def?: CustomFieldDef) => def?.dataType === 'MULTIPLE_OPTIONS';
const ci = (v: unknown) => String(v ?? '').trim().toLowerCase();

/** Scalar keys whose values are URLs — compared scheme/www/slash-insensitively (mirrors
 *  downsync.URL_SCALAR_KEYS/normUrl; kept local so the generic engine has no dep on the
 *  built-in engine). "https://x.com" and "x.com" must not churn. */
const WEBSITE_KEYS: ReadonlySet<string> = new Set(['website']);
const bareOf = (k: string) => (k.includes('.') ? k.split('.').slice(1).join('.') : k);
const normUrl = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');

/** A per-row value transform. Mirrors lib/sync/downsync.applyTransform, kept local so the generic
 *  engine has no dependency on the built-in contact↔company engine. A transformed value is opaque:
 *  it bypasses this field's option→label coercion and is compared case-insensitively.
 *  'countryCode': uppercase+trim the ISO code, synced verbatim ("us"/"US" never churn). */
export function transformValue(transform: string | undefined, value: unknown): unknown {
  if (transform === 'countryCode' && value != null && value !== '') return String(value).trim().toUpperCase();
  return value;
}

/** Canonicalize a SOURCE value into a cross-object-comparable form using the SOURCE field def:
 *  an option is stored as a per-field KEY, so resolve it to its shared LABEL before proposing to
 *  the target (paired fields share labels, not keys). Without this the target sees a foreign key
 *  and every option field churns. Mirrors downsync.businessValueToContactInput, generalized. */
export function canonicalizeSource(raw: unknown, sourceDef?: CustomFieldDef): unknown {
  if (raw == null || raw === '') return raw;
  if (isOption(sourceDef)) return optionKeyToLabel(raw, sourceDef?.options) ?? raw;
  if (isMulti(sourceDef)) {
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr.map((v) => optionKeyToLabel(v, sourceDef?.options) ?? v).filter((v) => v != null && v !== '');
  }
  return raw;
}

/** The value that would be written to the target field. `raw` should already be canonicalized
 *  (see canonicalizeSource) so option labels resolve against the TARGET's options. */
export function proposedValue(raw: unknown, def?: CustomFieldDef, transform?: string): unknown {
  if (raw == null || raw === '') return raw;
  if (transform) return transformValue(transform, raw); // opaque — skip option→label coercion
  // Option fields: resolve to a real target option or SKIP (null → dropped by the caller's blank
  // guard). Never fall back to the raw string — that would write a stale/foreign value into a
  // picklist (GHL rejects it / stores garbage). Matches the built-in engine, which skips unresolvable options.
  if (isOption(def) && def?.options) return resolveOptionLabel(raw, def.options);
  if (isMulti(def) && def?.options) {
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr.map((v) => resolveOptionLabel(v, def.options)).filter((v): v is string => !!v);
  }
  if (def?.dataType === 'DATE') return toGhlDate(raw) ?? raw;
  return typeof raw === 'string' ? raw.trim() : raw;
}

/** Compare a target's current value to the proposed one, in the field's stored form. Field-aware:
 *  options by KEY, multi-options as key sets, DATE by YYYY-MM-DD, website URL-normalized, and all
 *  other scalars case/whitespace-insensitively — matching the built-in engine's equality guards. */
export function equalForField(def: CustomFieldDef | undefined, current: unknown, proposed: unknown, transform?: string, targetKey?: string): boolean {
  if (!transform && isOption(def) && def?.options) {
    const a = resolveOptionKey(current, def.options);
    const b = resolveOptionKey(proposed, def.options);
    return a != null && b != null ? a === b : ci(current) === ci(proposed);
  }
  if (!transform && isMulti(def) && def?.options) {
    const a = resolveOptionKeys(current, def.options).sort();
    const b = resolveOptionKeys(proposed, def.options).sort();
    return JSON.stringify(a) === JSON.stringify(b);
  }
  if (!transform && def?.dataType === 'DATE') {
    return String(current ?? '').slice(0, 10) === String(proposed ?? '').slice(0, 10);
  }
  if (!transform && targetKey && WEBSITE_KEYS.has(bareOf(targetKey))) {
    return normUrl(current) === normUrl(proposed);
  }
  if (Array.isArray(current) && Array.isArray(proposed)) {
    return JSON.stringify([...current].map(String).sort()) === JSON.stringify([...proposed].map(String).sort());
  }
  return ci(current) === ci(proposed);
}

/** No-downgrade guard: refuse to overwrite an existing (non-blank) target value with a hold value. */
export function isHeldDowngrade(holdValues: string[] | undefined, current: unknown, proposed: unknown): boolean {
  if (!holdValues?.length) return false;
  const isBlank = current == null || current === '' || (Array.isArray(current) && current.length === 0);
  if (isBlank) return false;
  const hold = new Set(holdValues.map((v) => v.toLowerCase()));
  return [proposed].flat().every((v) => hold.has(String(v).toLowerCase()));
}

export interface DryRunDeps {
  readRecordFields: typeof readRecordFields;
  resolveCounterpartIds: typeof resolveCounterpartIds;
  getCatalog: (objectKey: string) => Promise<CustomFieldCatalog>;
}

/** Plan (without writing) what `connection` would push from one source record to its counterparts. */
export async function planConnectionDryRun(
  connection: DryRunConnection,
  sourceRecordId: string,
  deps?: Partial<DryRunDeps>,
  client?: GhlClient,
): Promise<ConnectionDryRun> {
  const readRec = deps?.readRecordFields ?? readRecordFields;
  const resolveIds = deps?.resolveCounterpartIds ?? resolveCounterpartIds;
  const getCat = deps?.getCatalog ?? ((k: string) => getCatalog(k, { client }));

  const base: Omit<ConnectionDryRun, 'counterparts' | 'counterpartCount'> = {
    sourceObject: connection.sourceObject,
    targetObject: connection.targetObject,
    associationId: connection.associationId,
    sourceRecordId,
  };

  const pushRows = connection.rows.filter((r) => r.enabled !== false && (r.direction === 'up' || r.direction === 'both'));
  if (!pushRows.length) return { ...base, counterpartCount: 0, counterparts: [], note: 'no source→target rows' };

  const [source, sourceCatalog, targetCatalog, ids] = await Promise.all([
    readRec(connection.sourceObject, sourceRecordId, client),
    getCat(connection.sourceObject),
    getCat(connection.targetObject),
    resolveIds(connection, sourceRecordId, client),
  ]);

  if (!ids.length) return { ...base, counterpartCount: 0, counterparts: [], note: 'no linked records on the target side' };

  const counterparts: DryRunCounterpart[] = [];
  for (const targetId of ids) {
    const target = await readRec(connection.targetObject, targetId, client);
    const changes: DryRunChange[] = [];
    const skipped: { targetKey: string; reason: string }[] = [];
    let unchanged = 0;
    for (const row of pushRows) {
      const def = targetCatalog.byKey[row.targetKey];
      const raw = source.get(row.sourceKey);
      if (raw == null || raw === '' || (Array.isArray(raw) && raw.length === 0)) { continue; }
      const canonical = row.transform ? raw : canonicalizeSource(raw, sourceCatalog.byKey[row.sourceKey]);
      const proposed = proposedValue(canonical, def, row.transform);
      if (proposed == null || proposed === '' || (Array.isArray(proposed) && proposed.length === 0)) { continue; }
      const current = target.get(row.targetKey);
      if (equalForField(def, current, proposed, row.transform, row.targetKey)) { unchanged++; continue; }
      if (isHeldDowngrade(row.holdValues, current, proposed)) { skipped.push({ targetKey: row.targetKey, reason: `no-downgrade: kept ${JSON.stringify(current)}` }); continue; }
      changes.push({ sourceKey: row.sourceKey, targetKey: row.targetKey, from: current, to: proposed });
    }
    counterparts.push({ targetId, changes, unchanged, skipped });
  }

  return { ...base, counterpartCount: counterparts.length, counterparts };
}
