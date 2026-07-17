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

/** Diff source→target for a set of rows (returns per-field changes; source value is what we write). */
function diff(
  getSource: (k: string) => unknown,
  getTarget: (k: string) => unknown,
  rows: { sourceKey: string; targetKey: string }[],
  targetCatalog: CustomFieldCatalog,
): { changes: ApplyChange[]; unchanged: number; writeValues: Record<string, unknown> } {
  const changes: ApplyChange[] = [];
  const writeValues: Record<string, unknown> = {};
  let unchanged = 0;
  for (const row of rows) {
    const raw = getSource(row.sourceKey);
    if (raw == null || raw === '' || (Array.isArray(raw) && raw.length === 0)) continue;
    const def = targetCatalog.byKey[row.targetKey];
    const proposed = proposedValue(raw, def);
    const current = getTarget(row.targetKey);
    if (equalForField(def, current, proposed)) { unchanged++; continue; }
    changes.push({ fieldKey: row.targetKey, from: current, to: proposed });
    writeValues[row.targetKey] = raw; // write the source raw; writeRecordFields coerces to target
  }
  return { changes, unchanged, writeValues };
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
  const pushRows = connection.rows.filter((r) => r.direction === 'up' || r.direction === 'both');
  const pullRows = connection.rows.filter((r) => r.direction === 'down');

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
    const { changes, unchanged, writeValues } = diff((k) => source.get(k), (k) => target.get(k), pushRows, targetCatalog);
    let written: string[] = [];
    let skipped: Array<{ key: string; reason: string }> = [];
    if (opts.apply && changes.length) {
      const w = await write(connection.targetObject, targetId, writeValues, targetCatalog, client);
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
      // reverse rows are target→source: swap source/target keys.
      const revRows = pullRows.map((r) => ({ sourceKey: r.targetKey, targetKey: r.sourceKey }));
      const { changes, unchanged, writeValues } = diff((k) => target.get(k), (k) => source.get(k), revRows, sourceCatalog);
      let written: string[] = []; let skipped: Array<{ key: string; reason: string }> = [];
      if (opts.apply && changes.length) {
        const w = await write(connection.sourceObject, sourceRecordId, writeValues, sourceCatalog, client);
        written = w.written; skipped = w.skipped;
      }
      reverse = { changes, written, skipped, note: unchanged ? undefined : undefined };
    }
  }

  return { ...base, counterpartCount: ids.length, forward, reverse };
}
