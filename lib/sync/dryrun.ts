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
import { resolveOptionKey, resolveOptionLabel } from '../ghl/coerce';
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
}
export interface DryRunConnection {
  sourceObject: string;
  targetObject: string;
  associationId: string;
  rows: DryRunRow[];
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

/** A per-row value transform. Mirrors lib/sync/downsync.applyTransform, kept local so the generic
 *  engine has no dependency on the built-in contact↔company engine. A transformed value is opaque:
 *  it bypasses this field's option→label coercion and is compared case-insensitively.
 *  'countryCode': uppercase+trim the ISO code, synced verbatim ("us"/"US" never churn). */
export function transformValue(transform: string | undefined, value: unknown): unknown {
  if (transform === 'countryCode' && value != null && value !== '') return String(value).trim().toUpperCase();
  return value;
}

/** The value that would be written to the target field (option label for option types). */
export function proposedValue(raw: unknown, def?: CustomFieldDef, transform?: string): unknown {
  if (raw == null || raw === '') return raw;
  if (transform) return transformValue(transform, raw); // opaque — skip option→label coercion
  if (isOption(def) && def?.options) return resolveOptionLabel(raw, def.options) ?? String(raw);
  return typeof raw === 'string' ? raw.trim() : raw;
}

/** Compare a target's current value to the proposed one, in the field's stored form. */
export function equalForField(def: CustomFieldDef | undefined, current: unknown, proposed: unknown, transform?: string): boolean {
  if (!transform && isOption(def) && def?.options) {
    const a = resolveOptionKey(current, def.options);
    const b = resolveOptionKey(proposed, def.options);
    return a != null && b != null ? a === b : String(current ?? '') === String(proposed ?? '');
  }
  if (Array.isArray(current) && Array.isArray(proposed)) {
    return JSON.stringify([...current].map(String).sort()) === JSON.stringify([...proposed].map(String).sort());
  }
  return String(current ?? '').trim().toLowerCase() === String(proposed ?? '').trim().toLowerCase();
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

  const [source, targetCatalog, ids] = await Promise.all([
    readRec(connection.sourceObject, sourceRecordId, client),
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
      const proposed = proposedValue(raw, def, row.transform);
      const current = target.get(row.targetKey);
      if (equalForField(def, current, proposed, row.transform)) unchanged++;
      else changes.push({ sourceKey: row.sourceKey, targetKey: row.targetKey, from: current, to: proposed });
    }
    counterparts.push({ targetId, changes, unchanged, skipped });
  }

  return { ...base, counterpartCount: counterparts.length, counterparts };
}
