// lib/sync/apply.ts — two-way LIVE apply of a connection from ONE source record.
//
// Forward (up/both rows): source → each counterpart (fan-out write).
// Reverse (down/both rows): counterpart → source, but ONLY when there is exactly one
//   counterpart (unambiguous source-of-truth); with >1, reverse is skipped with a note.
// Reuses the dry-run diff (equalForField/proposedValue) + readRecordFields + resolveCounterpartIds
// + the generalized writeRecordFields. Only changed fields are written, so re-runs are no-ops.

import { readRecordFields } from '../ghl/records';
import { getCatalog } from '../ghl/catalogCache';
import { writeRecordFields } from '../ghl/writeRecord';
import { resolveCounterpartIds } from './traverse';
import { equalForField, proposedValue } from './dryrun';
import type { CustomFieldCatalog } from '../ghl/types';
import type { GhlClient } from '../ghl/client';
import type { DryRunConnection } from './dryrun';

export interface ApplyChange { fieldKey: string; from: unknown; to: unknown }
export interface ForwardResult { targetId: string; changes: ApplyChange[]; unchanged: number; written: string[]; skipped: Array<{ key: string; reason: string }> }
export interface ReverseResult { changes: ApplyChange[]; written: string[]; skipped: Array<{ key: string; reason: string }>; note?: string }
export interface ApplyResult {
  sourceObject: string;
  targetObject: string;
  sourceRecordId: string;
  counterpartCount: number;
  applied: boolean;
  forward: ForwardResult[];
  reverse: ReverseResult | null;
  note?: string;
}

export interface ApplyDeps {
  readRecordFields: typeof readRecordFields;
  resolveCounterpartIds: typeof resolveCounterpartIds;
  getCatalog: (objectKey: string) => Promise<CustomFieldCatalog>;
  writeRecordFields: typeof writeRecordFields;
}

/** The bare form of a field key ("business.country" → "country"), for the opaque-write set. */
const bareKey = (k: string) => (k.includes('.') ? k.split('.').slice(1).join('.') : k);

/** Diff source→target for a set of rows (returns per-field changes; source value is what we write).
 *  Transformed rows write the transformed value opaquely (bare key added to `rawKeys` so the writer
 *  bypasses option coercion — e.g. countryCode syncs the ISO code verbatim). */
function diff(
  getSource: (k: string) => unknown,
  getTarget: (k: string) => unknown,
  rows: { sourceKey: string; targetKey: string; transform?: string }[],
  targetCatalog: CustomFieldCatalog,
): { changes: ApplyChange[]; unchanged: number; writeValues: Record<string, unknown>; rawKeys: Set<string> } {
  const changes: ApplyChange[] = [];
  const writeValues: Record<string, unknown> = {};
  const rawKeys = new Set<string>();
  let unchanged = 0;
  for (const row of rows) {
    const raw = getSource(row.sourceKey);
    if (raw == null || raw === '' || (Array.isArray(raw) && raw.length === 0)) continue;
    const def = targetCatalog.byKey[row.targetKey];
    const proposed = proposedValue(raw, def, row.transform);
    const current = getTarget(row.targetKey);
    if (equalForField(def, current, proposed, row.transform)) { unchanged++; continue; }
    changes.push({ fieldKey: row.targetKey, from: current, to: proposed });
    if (row.transform) {
      writeValues[row.targetKey] = proposed;      // already-transformed value, written verbatim
      rawKeys.add(bareKey(row.targetKey));         // opaque: skip the writer's option coercion
    } else {
      writeValues[row.targetKey] = raw;            // write the source raw; writeRecordFields coerces
    }
  }
  return { changes, unchanged, writeValues, rawKeys };
}

/** Apply (or, with apply:false, plan) a two-way connection from one source record. */
export async function syncConnection(
  connection: DryRunConnection,
  sourceRecordId: string,
  opts: { apply: boolean },
  deps?: Partial<ApplyDeps>,
  client?: GhlClient,
): Promise<ApplyResult> {
  const readRec = deps?.readRecordFields ?? readRecordFields;
  const resolveIds = deps?.resolveCounterpartIds ?? resolveCounterpartIds;
  const getCat = deps?.getCatalog ?? ((k: string) => getCatalog(k, { client }));
  const write = deps?.writeRecordFields ?? writeRecordFields;

  const base = { sourceObject: connection.sourceObject, targetObject: connection.targetObject, sourceRecordId, applied: opts.apply };
  // Apply is FROM the source record: push what the source owns (up + both), and pull only
  // pure 'down' rows (target owns those). A 'both' field is pushed here — pulling it in the
  // same pass would conflict with the push on that field.
  // Disabled rows (enabled === false) are never synced — matches the built-in engine's gate.
  const active = connection.rows.filter((r) => r.enabled !== false);
  const pushRows = active.filter((r) => r.direction === 'up' || r.direction === 'both');
  const pullRows = active.filter((r) => r.direction === 'down');

  const [source, sourceCatalog, targetCatalog, ids] = await Promise.all([
    readRec(connection.sourceObject, sourceRecordId, client),
    getCat(connection.sourceObject),
    getCat(connection.targetObject),
    resolveIds(connection, sourceRecordId, client),
  ]);

  if (!ids.length) return { ...base, counterpartCount: 0, forward: [], reverse: null, note: 'no linked records on the target side' };

  // Forward: source → each counterpart.
  const forward: ForwardResult[] = [];
  for (const targetId of ids) {
    const target = await readRec(connection.targetObject, targetId, client);
    const { changes, unchanged, writeValues, rawKeys } = diff((k) => source.get(k), (k) => target.get(k), pushRows, targetCatalog);
    let written: string[] = [];
    let skipped: Array<{ key: string; reason: string }> = [];
    if (opts.apply && changes.length) {
      const w = await write(connection.targetObject, targetId, writeValues, targetCatalog, client, rawKeys);
      written = w.written; skipped = w.skipped;
    }
    forward.push({ targetId, changes, unchanged, written, skipped });
  }

  // Reverse: counterpart → source (only when unambiguous — exactly one counterpart).
  let reverse: ReverseResult | null = null;
  if (pullRows.length) {
    if (ids.length !== 1) {
      reverse = { changes: [], written: [], skipped: [], note: `reverse (pull) skipped: ${ids.length} counterparts, ambiguous source-of-truth` };
    } else {
      const target = await readRec(connection.targetObject, ids[0], client);
      // reverse rows are target→source: swap source/target keys (transform carries over).
      const revRows = pullRows.map((r) => ({ sourceKey: r.targetKey, targetKey: r.sourceKey, transform: r.transform }));
      const { changes, unchanged, writeValues, rawKeys } = diff((k) => target.get(k), (k) => source.get(k), revRows, sourceCatalog);
      let written: string[] = []; let skipped: Array<{ key: string; reason: string }> = [];
      if (opts.apply && changes.length) {
        const w = await write(connection.sourceObject, sourceRecordId, writeValues, sourceCatalog, client, rawKeys);
        written = w.written; skipped = w.skipped;
      }
      reverse = { changes, written, skipped, note: unchanged ? undefined : undefined };
    }
  }

  return { ...base, counterpartCount: ids.length, forward, reverse };
}
