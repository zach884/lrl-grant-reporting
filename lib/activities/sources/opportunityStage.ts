// lib/activities/sources/opportunityStage.ts — a pipeline stage → a Program Acceptance activity.
//
// This adapter exists for the report engine, not for the CRM: program-acceptance records are what
// give each company its program ENROLLMENT INTERVALS, and an activity's grant attribution derives
// from "which programs was this company in on this date". See docs/sprints/report-engine-design.md.
//
// TWO THINGS MEASURED LIVE (2026-08-19) SHAPE IT:
//
// 1. AN OPPORTUNITY IS ONLY EVER IN ONE STAGE, so history is not recoverable from current state.
//    Of 97 LOCAL Fellows opportunities, ZERO are sitting in "Selected for Bootcamp" — the 52 that
//    were selected have all moved on (39 Bootcamp Completed, 9 Received Milestone Grant, …). So a
//    backfill keyed on the acceptance stage alone would find nothing.
//    → Config can therefore route SEVERAL stages to one enrollment: any downstream stage implies
//      the company was accepted. S&MA is the easy case (32 sit in the terminal Closed Won).
//
// 2. WHICH MEANS THE SOURCE KEY IS THE ENROLLMENT, NOT THE STAGE TRANSITION.
//    Keyed per stage, a fellow who passed through four routed stages would produce four enrollment
//    records. The key is `<opportunityId>:<program>` so every qualifying stage converges on ONE
//    record, and moving between them is a noop.
//
// DATE HONESTY: on the webhook path `lastStageChangeAt` IS the moment of acceptance. On a backfill
// of a DOWNSTREAM stage it is the date of some later move, so the record is stamped with the
// opportunity's `createdAt` instead and flagged as approximate in the notes. Grant periods bound
// reporting, so an approximate enrollment start is usable — but it must never be presented as exact.

import { GhlClient, ghl } from '../../ghl/client';
import { getContact } from '../../ghl/contacts';
import { upsertActivity, type UpsertActivityResult } from '../upsert';
import { getCatalog } from '../../ghl/catalogCache';
import { resolveRoute } from '../routes';
import { ACTIVITIES_OBJECT } from '../schema';
import type { CreateActivityOptions } from '../create';

/**
 * Keys in a route's `defaults` that are CONTROL FLAGS rather than field values.
 *
 * `defaults` is config-as-data and deliberately carries both — it is the only per-route bag there is
 * — so anything added here must be stripped before the write. A flag left in `values` is handed to
 * GHL as a field name; harmless today because unknown keys are skipped, but it would silently mask a
 * real typo'd field.
 */
export const ROUTE_FLAGS = ['impliesAcceptance', 'copyFormFields'] as const;

/**
 * Merge the contact's copied form values into the stage's values. Exported so the guard is testable.
 *
 * Three rules, and each one is a bug that was going to happen:
 *
 * 1. 🔴 **`activity_date` is never taken from the form.** A live dry run of the form path showed it
 *    WOULD write it. The stage's own date is the truth here, and the ingest path additionally lists
 *    it in `onlyIfAbsent`. This is the drift that put the backfill's run date on 52 grant records and
 *    replaced real award dates in the funder's column S.
 * 2. **The route's own defaults win.** `grant_status` is derived from the STAGE, which is by
 *    definition more current than whatever the application said when it was submitted.
 * 3. **Nothing already set is overwritten**, so a value the stage computed (the name, the program
 *    association) survives a copy.
 */
export function mergeFormValues(
  values: Record<string, unknown>,
  copied: Record<string, unknown>,
  routeDefaults?: Record<string, unknown> | null,
): Record<string, unknown> {
  for (const [k, v] of Object.entries(copied)) {
    if (k === 'activity_date') continue;
    if (routeDefaults && k in routeDefaults) continue;
    if (values[k] === undefined) values[k] = v;
  }
  return values;
}

export const OPPORTUNITY_SOURCE = 'Opportunity Stage';

export interface GhlOpportunity {
  id: string;
  name?: string;
  pipelineId?: string;
  pipelineStageId?: string;
  contactId?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  lastStageChangeAt?: string;
}

export type OppSkipReason = 'no-route' | 'no-contact' | 'no-company' | 'no-date';

export interface OpportunityIngestResult {
  opportunityId: string;
  status: 'ingested' | 'skipped';
  reason?: OppSkipReason;
  detail?: string;
  route?: { activityType: string; matchLabel?: string; program?: string[] };
  /** True when the date is inferred rather than the actual stage-change moment. */
  approximateDate?: boolean;
  activity?: UpsertActivityResult;
  /** Declared key-mismatch aliases that FIRED while copying the form's fields (see FIELD_ALIASES).
   *  Present only when non-empty, so a rename that breaks one shows up as this disappearing. */
  aliases?: Array<{ from: string; to: string; note: string }>;
}

/** Fetch one opportunity. */
export async function getOpportunity(id: string, client: GhlClient = ghl()): Promise<GhlOpportunity | null> {
  const data = await client.request<any>({ path: `/opportunities/${id}`, autoLocation: false });
  const o = data.opportunity ?? data;
  return o?.id ? (o as GhlOpportunity) : null;
}

/**
 * One enrollment per opportunity per program — NOT per stage.
 *
 * This is the whole reason several stages can safely map to one enrollment: they all resolve to the
 * same key, so the second and subsequent ones are noops instead of duplicate enrollments.
 */
export function enrollmentKey(opportunityId: string, program: string[] | undefined, activityType: string): string {
  const suffix = program?.length ? [...program].sort().join('+') : activityType;
  return `${opportunityId}:${suffix}`;
}

export interface OppIngestOptions extends CreateActivityOptions {
  dryRun?: boolean;
  /** True when reading current state in bulk rather than reacting to a stage-change event. */
  backfill?: boolean;
}

/** Turn one opportunity's current stage into a Program Acceptance activity (or explain why not). */
export async function ingestOpportunity(
  opp: GhlOpportunity,
  opts: OppIngestOptions = {},
): Promise<OpportunityIngestResult> {
  const client = opts.client ?? ghl();
  const base = { opportunityId: opp.id };

  const route = await resolveRoute(OPPORTUNITY_SOURCE, [{ kind: 'pipeline_stage', id: opp.pipelineStageId }]);
  if (!route) {
    return { ...base, status: 'skipped', reason: 'no-route', detail: `stage ${opp.pipelineStageId ?? '(none)'} has no routing rule` };
  }
  const routeInfo = { activityType: route.activityType, matchLabel: route.matchLabel, program: route.program };

  if (!opp.contactId) return { ...base, status: 'skipped', reason: 'no-contact', route: routeInfo };
  const contact = await getContact(opp.contactId, client).catch(() => null);
  const companyId = (contact as any)?.businessId as string | undefined;
  if (!companyId) {
    return {
      ...base,
      status: 'skipped',
      reason: 'no-company',
      detail: `contact ${opp.contactId} has no businessId — link the contact to its company, then re-run`,
      route: routeInfo,
    };
  }

  // A backfill sees only where the opportunity is NOW. If the routed stage is a downstream one, the
  // last stage change is some later move, not the acceptance — so fall back to when the opportunity
  // was created and say so rather than publishing a confident wrong date.
  const isDownstream = Boolean(opts.backfill && route.defaults?.impliesAcceptance);
  const exactDate = opp.lastStageChangeAt;
  const date = isDownstream ? (opp.createdAt ?? exactDate) : (exactDate ?? opp.createdAt);
  if (!date) return { ...base, status: 'skipped', reason: 'no-date', route: routeInfo };

  const programLabel = await programLabels(route.program, client);
  // Name by what the record IS. An earlier cut called every pipeline-sourced record
  // "<program> acceptance", which named all 61 Direct Grants records "Program acceptance – …".
  const who = opp.name ?? companyId;
  const activityName =
    route.activityType === 'program_acceptance'
      ? `${programLabel} acceptance – ${who}`
      : `${route.matchLabel?.split('·')[0]?.trim() || 'Grant'} – ${who}`;
  const values: Record<string, unknown> = {
    activity_date: date,
    activity_name: activityName,
    ...(route.program?.length ? { program__grant_association: route.program } : {}),
    ...(isDownstream
      ? { activity_notes: `Enrollment inferred from the later stage "${route.matchLabel ?? opp.pipelineStageId}" during backfill; date is the opportunity's creation date, not the exact acceptance date.` }
      : {}),
    ...(route.defaults ?? {}),
  };
  // Config FLAGS, not fields. `defaults` carries both, so every flag must be stripped before the
  // write or it is offered to GHL as a field name.
  for (const flag of ROUTE_FLAGS) delete (values as any)[flag];

  // ── the form's detail fields, at the stage where they are final ────────────────────────────────
  // The pipeline gives a grant its record and its status; the FORM carries the ~44 detail fields,
  // and those live on the contact. Until now nothing copied them at the reportable moment: the
  // stage webhook arrived, and the field copy only ever ran from `form-ingest-run.ts` by hand.
  //
  // Gated on a route flag rather than hardcoded, so WHICH stages are "final" stays config. Set on
  // Agreement Executed and Closed Won: before execution the line items are still a proposal, and
  // re-copying at Closed Won is what picks up an AMENDED agreement (Zach, 2026-09-03: "if the line
  // items on the grant change due to an amended agreement I want the grant activity to have the last
  // version"). Copying twice is safe — the upsert diffs, so the second pass is a noop unless
  // something genuinely changed.
  //
  // ⚠️ `activity_date` is NOT taken from the form. It is in `onlyIfAbsent` below, and a live dry run
  // of the form path showed it WOULD write it — which is exactly the drift that put the backfill's
  // run date on 52 grant records. The guard is what stops it, and a test asserts the guard.
  const aliasesUsed: Array<{ from: string; to: string; note: string }> = [];
  if (route.defaults?.copyFormFields) {
    const { mapContactValuesToActivity } = await import('./form');
    const { activityFieldSet, bareKey } = await import('../schema');
    const { getCatalog } = await import('../../ghl/catalogCache');
    try {
      const [activityCatalog, contactCatalog] = await Promise.all([
        getCatalog(ACTIVITIES_OBJECT, { client }),
        getCatalog('contact', { client }),
      ]);
      const contact: any = await client.request({ path: `/contacts/${opp.contactId}` });
      const set = activityFieldSet(activityCatalog as any, route.activityType);
      const keys = new Set([...set.core, ...set.typeFields].map(bareKey));
      const copied = mapContactValuesToActivity(
        (contact.contact ?? contact) as any, (contactCatalog as any).byId, keys,
        (a) => aliasesUsed.push({ from: a.from, to: a.to, note: a.note }),
      );
      mergeFormValues(values, copied, route.defaults);
    } catch (e) {
      // A field copy that fails must not lose the stage change itself. The status is the load-bearing
      // part; the detail fields can be picked up by the next delivery or by form-ingest-run.
      values.activity_notes = [values.activity_notes, `Form field copy failed at this stage: ${e instanceof Error ? e.message : String(e)}`]
        .filter(Boolean).join('\n\n');
    }
  }

  for (const k of Object.keys(values)) if (values[k] === undefined) delete values[k];

  // Dry runs PLAN through upsertActivity (plan:true) instead of stopping short, so the review shows
  // would-create / would-update(fields) / noop rather than restating the intent for every row.
  const activity = await upsertActivity(
    { source: OPPORTUNITY_SOURCE, sourceRecordId: enrollmentKey(opp.id, route.program, route.activityType) },
    { type: route.activityType, companyId, contactIds: [opp.contactId], values },
    {
      ...opts,
      mode: 'ingest',
      actorKind: 'sync',
      // WHEN something happened is set ONCE, for every type this adapter produces. Several stages
      // map to the same record, so without this each advance through the pipeline pushes the date
      // forward — a wrong date that looks entirely plausible.
      //
      // This was originally applied to program_acceptance only, and grants were left unprotected.
      // Measured 2026-08-31, before the nightly sweep was scheduled: a single sweep would have
      // rewritten `activity_date` on ALL 50 grant activities to the latest stage-change moment.
      // That field is the funder's "Date Direct Grant Awarded" (Trusted Connector column S), so the
      // real award dates would have been replaced by the date the sweep happened to run.
      //
      // Names and notes stay updatable for grants on purpose: a record's name can legitimately be
      // improved (see the pipeline-naming change in b44ba4d), whereas its date cannot.
      onlyIfAbsent: route.activityType === 'program_acceptance'
        ? ['activity_date', 'activity_name', 'activity_notes']
        : ['activity_date'],
      plan: opts.dryRun,
    },
  );
  return {
    ...base, status: 'ingested', route: routeInfo, approximateDate: isDownstream, activity,
    ...(aliasesUsed.length ? { aliases: aliasesUsed } : {}),
    ...(opts.dryRun
      ? { detail: `${activity.outcome}${activity.written.length ? `: ${activity.written.join(', ')}` : ''} — company ${companyId} in ${programLabel} as of ${String(date).slice(0, 10)}` }
      : {}),
  };
}

/** Option KEYS ("local") read badly in a record name; resolve them to their labels ("LOCAL"). */
async function programLabels(program: string[] | undefined, client: GhlClient): Promise<string> {
  if (!program?.length) return 'Program';
  const catalog = await getCatalog('custom_objects.activities', { client });
  const opts = catalog.byKey['custom_objects.activities.program__grant_association']?.options ?? [];
  return program.map((k) => opts.find((o) => o.key === k)?.label ?? k).join(', ');
}

/** Fetch by id, then ingest. The webhook path. */
export async function ingestOpportunityById(id: string, opts: OppIngestOptions = {}): Promise<OpportunityIngestResult> {
  const client = opts.client ?? ghl();
  const opp = await getOpportunity(id, client);
  if (!opp) return { opportunityId: id, status: 'skipped', reason: 'no-route', detail: 'opportunity not found' };
  return ingestOpportunity(opp, opts);
}

/** Every opportunity in a pipeline — the backfill reader. */
export async function listOpportunities(pipelineId: string, client: GhlClient = ghl()): Promise<GhlOpportunity[]> {
  const out: GhlOpportunity[] = [];
  let page = 1;
  for (;;) {
    const data = await client.request<any>({
      path: '/opportunities/search',
      autoLocation: false,
      params: { location_id: client.locationId, pipeline_id: pipelineId, limit: '100', page: String(page) },
    });
    const batch: GhlOpportunity[] = data.opportunities ?? [];
    out.push(...batch);
    if (batch.length < 100) break;
    page += 1;
    if (page > 20) break; // safety stop
  }
  return out;
}
