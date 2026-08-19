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
import { equalForField, proposedValue, canonicalizeSource, isHeldDowngrade } from './dryrun';
import { guardChanges, recordLedger } from './convergenceGuard';
import { logChange } from '../audit/log';
import type { CustomFieldCatalog } from '../ghl/types';
import type { GhlClient } from '../ghl/client';
import type { DryRunConnection } from './dryrun';
import { resolveRecordLabel, labelFromFields } from '../audit/label';

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

interface DiffRow { sourceKey: string; targetKey: string; transform?: string; holdValues?: string[] }

/** Diff source→target for a set of rows (returns per-field changes; the resolved target value is
 *  what we write). Source option KEYS are canonicalized to shared LABELS via the SOURCE catalog
 *  before proposing to the target (else cross-object option fields churn). Field-aware equality +
 *  the no-downgrade hold guard mirror the built-in engine. Transformed rows write opaquely (bare
 *  key added to `rawKeys` so the writer bypasses option coercion — e.g. countryCode). */
function diff(
  getSource: (k: string) => unknown,
  getTarget: (k: string) => unknown,
  rows: DiffRow[],
  sourceCatalog: CustomFieldCatalog,
  targetCatalog: CustomFieldCatalog,
): { changes: ApplyChange[]; unchanged: number; writeValues: Record<string, unknown>; rawKeys: Set<string>; skipped: Array<{ key: string; reason: string }> } {
  const changes: ApplyChange[] = [];
  const writeValues: Record<string, unknown> = {};
  const rawKeys = new Set<string>();
  const skipped: Array<{ key: string; reason: string }> = [];
  let unchanged = 0;
  for (const row of rows) {
    const raw = getSource(row.sourceKey);
    if (raw == null || raw === '' || (Array.isArray(raw) && raw.length === 0)) continue;
    const def = targetCatalog.byKey[row.targetKey];
    const canonical = row.transform ? raw : canonicalizeSource(raw, sourceCatalog.byKey[row.sourceKey]);
    const proposed = proposedValue(canonical, def, row.transform);
    if (proposed == null || proposed === '' || (Array.isArray(proposed) && proposed.length === 0)) continue;
    const current = getTarget(row.targetKey);
    if (equalForField(def, current, proposed, row.transform, row.targetKey)) { unchanged++; continue; }
    if (isHeldDowngrade(row.holdValues, current, proposed)) { skipped.push({ key: row.targetKey, reason: `no-downgrade: kept ${JSON.stringify(current)}` }); continue; }
    changes.push({ fieldKey: row.targetKey, from: current, to: proposed });
    writeValues[row.targetKey] = proposed;         // resolved target value; writer coerces to stored form
    if (row.transform) rawKeys.add(bareKey(row.targetKey)); // opaque: skip the writer's option coercion
  }
  return { changes, unchanged, writeValues, rawKeys, skipped };
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
    const { changes, unchanged, writeValues, rawKeys, skipped: heldSkips } = diff((k) => source.get(k), (k) => target.get(k), pushRows, sourceCatalog, targetCatalog);
    // Convergence guard: drop any change that re-proposes a value we already wrote but that didn't
    // stick (non-converging → would loop). Best-effort; no DB => no suppression.
    const guard = await guardChanges(targetId, changes);
    const writeVals = { ...writeValues };
    for (const s of guard.suppressed) delete writeVals[s.key];
    let written: string[] = [];
    let skipped: Array<{ key: string; reason: string }> = [...heldSkips, ...guard.suppressed];
    if (opts.apply && guard.keep.length) {
      const w = await write(connection.targetObject, targetId, writeVals, targetCatalog, client, rawKeys);
      written = w.written; skipped = [...heldSkips, ...guard.suppressed, ...w.skipped];
      await recordLedger(targetId, written.map((k) => ({ fieldKey: k, value: writeVals[k] })));
    }
    if (guard.keep.length) {
      await logChange({
        objectType: connection.targetObject, recordId: targetId, actorKind: 'sync',
        // Without a label the log reads "update business" + a raw id, which meant pasting ids into
        // GHL to review a night's writes. Memoised, so a sweep costs one read per record.
        recordLabel: await resolveRecordLabel(connection.targetObject, targetId, client),
        actorName: connection.name ?? `${connection.sourceObject}->${connection.targetObject}`,
        changes: guard.keep.map((c) => ({ field: c.fieldKey, from: c.from, to: c.to })), applied: opts.apply,
      });
    }
    forward.push({ targetId, changes: guard.keep, unchanged, written, skipped });
  }

  // Reverse: counterpart → source (only when unambiguous — exactly one counterpart).
  let reverse: ReverseResult | null = null;
  if (pullRows.length) {
    if (ids.length !== 1) {
      reverse = { changes: [], written: [], skipped: [], note: `reverse (pull) skipped: ${ids.length} counterparts, ambiguous source-of-truth` };
    } else {
      const target = await readRec(connection.targetObject, ids[0], client);
      // reverse rows are target→source: swap source/target keys (transform + hold carry over).
      // The reverse SOURCE is the counterpart (targetObject) — canonicalize via targetCatalog; the
      // reverse TARGET is the source record (sourceObject) — coerce/compare via sourceCatalog.
      const revRows = pullRows.map((r) => ({ sourceKey: r.targetKey, targetKey: r.sourceKey, transform: r.transform, holdValues: r.holdValues }));
      const { changes, writeValues, rawKeys, skipped: heldSkips } = diff((k) => target.get(k), (k) => source.get(k), revRows, targetCatalog, sourceCatalog);
      const guard = await guardChanges(sourceRecordId, changes);
      const writeVals = { ...writeValues };
      for (const s of guard.suppressed) delete writeVals[s.key];
      let written: string[] = []; let skipped: Array<{ key: string; reason: string }> = [...heldSkips, ...guard.suppressed];
      if (opts.apply && guard.keep.length) {
        const w = await write(connection.sourceObject, sourceRecordId, writeVals, sourceCatalog, client, rawKeys);
        written = w.written; skipped = [...heldSkips, ...guard.suppressed, ...w.skipped];
        await recordLedger(sourceRecordId, written.map((k) => ({ fieldKey: k, value: writeVals[k] })));
      }
      if (guard.keep.length) {
        await logChange({
          objectType: connection.sourceObject, recordId: sourceRecordId, actorKind: 'sync',
          // `source` is already in hand here, so this needs no read at all.
          recordLabel: labelFromFields(connection.sourceObject, (k) => source.get(k)),
          actorName: `${connection.name ?? connection.targetObject + '->' + connection.sourceObject} (reverse)`,
          changes: guard.keep.map((c) => ({ field: c.fieldKey, from: c.from, to: c.to })), applied: opts.apply,
        });
      }
      reverse = { changes: guard.keep, written, skipped };
    }
  }

  return { ...base, counterpartCount: ids.length, forward, reverse };
}
