// lib/activities/upsert.ts — find-or-create an activity by its SOURCE key.
//
// THE prerequisite for every ingestion adapter. Each source fires more than once for the same
// real-world event: GHL retries webhooks (fastAck.ts: "do not adopt this pattern for a non-idempotent
// handler"), clients resubmit forms, nightly syncs re-run. Without a natural key each retry creates
// another activity — and duplicate activities DOUBLE-COUNT in funder reports, which is the worst
// failure this system has because the numbers still look plausible.
//
// The key is (activity_source, source_record_id), stored on the record and looked up server-side.
// Probed live 2026-08-19 — the object search endpoint filters on a property:
//   POST /objects/{key}/records/search { filters: [{ field: 'properties.<bareKey>', operator: 'eq', value }] }
// (a bare `field: '<key>'` 422s, and the free-text `query` matches the record NAME only, so it cannot
// serve as a lookup.)
//
// Re-delivery of an unchanged event converges to `noop` — the house rule: a write path that can't
// report noop is broken.

import { GhlClient, ghl } from '../ghl/client';
import { getCatalog } from '../ghl/catalogCache';
import { writeRecordFields } from '../ghl/writeRecord';
import { didPersist } from '../ghl/objectWrite';
import { readRecordFields } from '../ghl/records';
import { logChange } from '../audit/log';
import type { ChangeLogFieldChange } from '../audit/types';
import { createActivity, type CreateActivityOptions, type CreateActivityResult } from './create';
import { claimSourceEvent, lookupClaim, releaseClaim, resolveClaim } from './claims';
import { ACTIVITIES_OBJECT, type ActivityInput } from './schema';

/** Which adapter wrote a record. Matches the `activity_source` option labels created on live. */
export type ActivitySource = 'Appointment' | 'Form' | 'Wix Attendance' | 'Opportunity Stage' | 'Manual';

export const SOURCE_FIELD = 'activity_source';
export const SOURCE_ID_FIELD = 'source_record_id';

/**
 * The stored option KEY for a source label. GHL lowercases option keys on creation, so "Wix
 * Attendance" is stored as some normalized form of itself; resolve it from the catalog instead of
 * reproducing GHL's normalization here, and fall back to the obvious transform if the field has no
 * options (a location where the setup script hasn't run yet).
 */
async function sourceOptionKey(source: ActivitySource, client: GhlClient): Promise<string> {
  const catalog = await getCatalog(ACTIVITIES_OBJECT, { client });
  const def = catalog.byKey[`${ACTIVITIES_OBJECT}.${SOURCE_FIELD}`];
  const hit = def?.options?.find((o) => o.label === source || o.key === source);
  return hit?.key ?? source.toLowerCase().replace(/\s+/g, '_');
}

/** Change-log actor name for an adapter, e.g. 'activity:appointment'. */
export const adapterName = (source: ActivitySource) => `activity:${source.toLowerCase().replace(/\s+/g, '-')}`;

export interface SourceKey {
  source: ActivitySource;
  /** The source system's own id for this event — appointment id, submission id, registration id. */
  sourceRecordId: string;
}

export interface UpsertActivityResult extends Partial<CreateActivityResult> {
  recordId: string;
  outcome: 'created' | 'updated' | 'noop';
  written: string[];
  skipped: Array<{ key: string; reason: string }>;
}

/**
 * The activity previously written for this source event, or null — via the GHL search index.
 *
 * ⚠️ The index LAGS a new record by ~12s (measured live), so this cannot stand alone as the
 * idempotency check; it is the fallback behind the claims ledger. Filters on BOTH halves of the key:
 * source ids are only unique within their own system, so an appointment id and a Wix registration id
 * could in principle collide.
 */
export async function findActivityBySource(
  key: SourceKey,
  client: GhlClient = ghl(),
): Promise<{ id: string; properties: Record<string, unknown> } | null> {
  if (!key.sourceRecordId) return null;
  // KEY, not label. `activity_source` is SINGLE_OPTIONS: the write sends the LABEL ("Manual") and
  // GHL stores the KEY ("manual"), so a filter on the label matches nothing — verified live
  // 2026-08-19 (label → 0 hits, key → 1). Getting this wrong doesn't error; it just never finds the
  // existing record, so every re-delivery creates a duplicate. Resolve through the catalog rather
  // than assuming GHL's lowercasing rule.
  const sourceValue = await sourceOptionKey(key.source, client);
  const data = await client.request<any>({
    method: 'POST',
    path: `/objects/${ACTIVITIES_OBJECT}/records/search`,
    autoLocation: false,
    body: {
      locationId: client.locationId,
      query: '',
      page: 1,
      pageLimit: 20,
      searchAfter: [],
      filters: [
        { field: `properties.${SOURCE_ID_FIELD}`, operator: 'eq', value: key.sourceRecordId },
        { field: `properties.${SOURCE_FIELD}`, operator: 'eq', value: sourceValue },
      ],
    },
  });
  const records: any[] = data.records ?? data.data ?? [];
  const hit = records[0];
  return hit ? { id: hit.id ?? hit._id, properties: hit.properties ?? {} } : null;
}

/**
 * Create the activity for this source event, or update the one already written for it.
 *
 * `input.values` is the desired end state. On update, only fields whose value actually changed are
 * written (writeRecordFields → applyObjectWrite diffs modifier fields and reads its writes back), so
 * a duplicate delivery reports `noop` and touches nothing.
 *
 * Associations are set at create only: they don't change for an existing event, and re-POSTing a
 * relation that exists is exactly the kind of write that should be a no-op.
 */
export interface UpsertOptions extends CreateActivityOptions {
  /**
   * Bare keys written ONLY when the record is created, never on a later update.
   *
   * For values that describe WHEN something began. A program enrollment is the case that forced
   * this: several pipeline stages imply one enrollment, so without it each advance would rewrite
   * `activity_date` to the newer stage-change moment and the enrollment start would silently drift
   * forward — a wrong date that looks entirely plausible.
   */
  onlyIfAbsent?: string[];
}

export async function upsertActivity(
  key: SourceKey,
  input: ActivityInput,
  opts: UpsertOptions = {},
): Promise<UpsertActivityResult> {
  const client = opts.client ?? ghl();
  const values = { ...input.values, [SOURCE_FIELD]: key.source, [SOURCE_ID_FIELD]: key.sourceRecordId };

  // Resolve "have we already recorded this event?" in three steps, cheapest and most reliable first:
  //   1. the claims ledger (Postgres, immediately consistent)
  //   2. the GHL search index (authoritative but ~12s behind, and covers events this app didn't claim)
  //   3. claim it — the unique constraint elects one winner among concurrent deliveries
  let existingId = await lookupClaim(key.source, key.sourceRecordId);
  let existingProps: Record<string, unknown> = {};
  if (!existingId) {
    const found = await findActivityBySource(key, client);
    if (found) {
      existingId = found.id;
      existingProps = found.properties;
      // Backfill the ledger so the next delivery skips the lagging search entirely.
      await resolveClaim(key.source, key.sourceRecordId, found.id);
    }
  }

  if (!existingId) {
    const claim = await claimSourceEvent(key.source, key.sourceRecordId);
    if (claim.status === 'existing' && claim.activityRecordId) {
      existingId = claim.activityRecordId;
    } else {
      // An adapter is recording something that already happened, so: ingest rules, and the change log
      // attributes it to the adapter rather than to a person (unless the caller named one).
      const ingestOpts: CreateActivityOptions = { mode: 'ingest', actorKind: 'sync', ...opts };
      if (!ingestOpts.actor) ingestOpts.actor = { name: adapterName(key.source) };
      try {
        const created = await createActivity({ ...input, values }, ingestOpts);
        await resolveClaim(key.source, key.sourceRecordId, created.recordId);
        return { ...created, outcome: 'created' };
      } catch (e) {
        // Free the claim so a retry can try again rather than finding a dead one.
        await releaseClaim(key.source, key.sourceRecordId);
        throw e;
      }
    }
  }

  // Don't rewrite the identity of a record we already wrote.
  const { [SOURCE_FIELD]: _s, [SOURCE_ID_FIELD]: _i, ...updatable } = values;
  const catalog = await getCatalog(ACTIVITIES_OBJECT, { client });
  const before = await readRecordFields(ACTIVITIES_OBJECT, existingId, client);

  // Diff HERE, not in the writer. `writeRecordFields` sends every scalar it is given (only modifier
  // fields diff internally), so handing it the full desired state would rewrite an unchanged record
  // on every re-delivery — churn, and a `noop` that can never be reported. In the sync engine the
  // dry-run planner owns this comparison; for ingestion, this is the planner.
  const isBlank = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
  const changed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(updatable)) {
    // Set-once fields keep whatever the create wrote (see onlyIfAbsent).
    if (opts.onlyIfAbsent?.includes(k) && !isBlank(before.get(k))) continue;
    const def = catalog.byKey[`${ACTIVITIES_OBJECT}.${k}`] ?? catalog.byKey[k];
    // didPersist answers "is the stored value equal to this one?", type-aware (a DATE written as
    // full ISO reads back as YYYY-MM-DD; a single-select written as a label reads back as a key).
    // null = can't judge → treat as changed and let the read-back verify.
    if (didPersist(def?.dataType, v, before.get(k), def) !== true) changed[k] = v;
  }

  const result = Object.keys(changed).length
    ? await writeRecordFields(ACTIVITIES_OBJECT, existingId, changed, catalog, client)
    : { written: [], skipped: [] };

  if (result.written.length) {
    const changes: ChangeLogFieldChange[] = result.written.map((k) => ({
      field: `${ACTIVITIES_OBJECT}.${k}`,
      from: before.get(k),
      to: changed[k],
      source: key.source,
    }));
    await logChange({
      objectType: ACTIVITIES_OBJECT,
      recordId: existingId,
      recordLabel: String(existingProps.activity_name ?? before.get('activity_name') ?? '') || undefined,
      actorKind: 'sync',
      actorName: adapterName(key.source),
      action: 'update',
      changes,
    });
  }

  return {
    recordId: existingId,
    outcome: result.written.length ? 'updated' : 'noop',
    written: result.written,
    skipped: result.skipped,
  };
}
