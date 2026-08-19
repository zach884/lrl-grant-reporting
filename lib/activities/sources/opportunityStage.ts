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
import type { CreateActivityOptions } from '../create';

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
  const values: Record<string, unknown> = {
    activity_date: date,
    activity_name: `${programLabel} acceptance – ${opp.name ?? companyId}`,
    ...(route.program?.length ? { program__grant_association: route.program } : {}),
    ...(isDownstream
      ? { activity_notes: `Enrollment inferred from the later stage "${route.matchLabel ?? opp.pipelineStageId}" during backfill; date is the opportunity's creation date, not the exact acceptance date.` }
      : {}),
    ...(route.defaults ?? {}),
  };
  delete (values as any).impliesAcceptance; // config flag, not a field
  for (const k of Object.keys(values)) if (values[k] === undefined) delete values[k];

  if (opts.dryRun) {
    return { ...base, status: 'ingested', route: routeInfo, approximateDate: isDownstream, detail: `would enroll company ${companyId} in ${programLabel} as of ${String(date).slice(0, 10)}` };
  }

  const activity = await upsertActivity(
    { source: OPPORTUNITY_SOURCE, sourceRecordId: enrollmentKey(opp.id, route.program, route.activityType) },
    { type: route.activityType, companyId, contactIds: [opp.contactId], values },
    {
      ...opts,
      mode: 'ingest',
      actorKind: 'sync',
      // WHEN an enrollment began is set once. Several stages imply the same enrollment, so without
      // this each advance through the pipeline would push the start date forward.
      onlyIfAbsent: route.activityType === 'program_acceptance' ? ['activity_date', 'activity_name', 'activity_notes'] : [],
    },
  );
  return { ...base, status: 'ingested', route: routeInfo, approximateDate: isDownstream, activity };
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
