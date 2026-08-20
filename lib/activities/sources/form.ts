// lib/activities/sources/form.ts — a GHL form submission → a Grant or Metrics activity.
//
// GHL forms write to CONTACT fields, not to the object. That is why 84 of the Grant/Metrics field
// keys read like contact keys — they were lifted from them. Measured 2026-08-19: **90% of Grant and
// 97% of Metrics activity fields share their contact field's key**, so the map is derived, not
// hand-authored, and a field added to both sides is picked up with no code change.
//
// WHY THIS MATTERS BEYOND CONVENIENCE: today a second Client Reporting submission OVERWRITES the
// first on the contact, so prior-period snapshots are being lost. Copying each submission onto its
// own activity record is what turns "the client's current numbers" into "a snapshot per period",
// which is what every funder report actually needs.
//
// IDENTITY, per type:
//   • Metrics — `<contactId>:<reportingPeriodEnd>`. ONE snapshot per client per half-year, which is
//     the real-world rule: a resubmission corrects the existing snapshot instead of adding a second.
//   • Grant   — `<opportunityId>:grant` under the OPPORTUNITY's source, because the opportunity IS
//     the grant (Zach). The form supplies the detail, the pipeline supplies `grant_status`, and they
//     converge on ONE record. ⚠️ The identity is (source, source_record_id) — BOTH halves — so the
//     form must adopt the opportunity's source as well as its id. An earlier cut matched only the id
//     and would have created 45 duplicate grant records on the first backfill. With no opportunity to
//     resolve, the submission is keyed by contact + date under `Form` and flagged, rather than
//     silently inventing a second grant.

import { GhlClient, ghl } from '../../ghl/client';
import { getContact } from '../../ghl/contacts';
import { getCatalog } from '../../ghl/catalogCache';
import { upsertActivity, type ActivitySource, type UpsertActivityResult } from '../upsert';
import { OPPORTUNITY_SOURCE } from './opportunityStage';
import { resolveRoute } from '../routes';
import { reportingPeriodFor } from '../reportingPeriod';
import { ACTIVITIES_OBJECT, activityFieldSet, bareKey, MACHINE_FIELDS } from '../schema';
import type { CreateActivityOptions } from '../create';

export const FORM_SOURCE = 'Form';

/** Fields never copied from the contact, whatever their key says. */
const NEVER_COPY = new Set([...Array.from(MACHINE_FIELDS), 'activity_type', 'activity_name', 'activity_date', 'activity_owner']);

export type FormSkipReason = 'no-route' | 'no-contact' | 'no-company' | 'no-values';

export interface FormIngestResult {
  contactId: string;
  formId?: string;
  status: 'ingested' | 'skipped';
  reason?: FormSkipReason;
  detail?: string;
  route?: { activityType: string; matchLabel?: string };
  /** How many contact fields were copied onto the activity. */
  copied?: number;
  reportingPeriod?: string;
  activity?: UpsertActivityResult;
}

export interface FormIngestOptions extends CreateActivityOptions {
  dryRun?: boolean;
  /** When the form was submitted. Defaults to now; a backfill should pass the real date. */
  submittedAt?: Date | string;
}

/**
 * The contact's values for the fields this activity type has, keyed by the ACTIVITY's bare key.
 *
 * Matching is by key, which is reliable precisely because the object's fields were lifted from the
 * contact's. Anything without a counterpart is simply absent — never guessed at by name similarity,
 * which would silently mis-file a number into the wrong funder metric.
 */
export function mapContactValuesToActivity(
  contact: { customFields?: Array<{ id: string; value?: unknown }> },
  contactCatalogById: Record<string, { fieldKey: string }>,
  activityFieldKeys: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const cf of contact.customFields ?? []) {
    const def = contactCatalogById[cf.id];
    if (!def?.fieldKey) continue;
    const key = def.fieldKey.replace(/^contact\./, '');
    if (!activityFieldKeys.has(key) || NEVER_COPY.has(key)) continue;
    const v = cf.value;
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    out[key] = v;
  }
  return out;
}

/** The contact's open Direct Grants opportunity, so the form lands on the pipeline's grant record. */
async function findGrantOpportunity(contactId: string, pipelineId: string, client: GhlClient): Promise<string | null> {
  try {
    const data = await client.request<any>({
      path: '/opportunities/search',
      autoLocation: false,
      params: { location_id: client.locationId, contact_id: contactId, pipeline_id: pipelineId, limit: '20' },
    });
    const opps: any[] = data.opportunities ?? [];
    if (!opps.length) return null;
    // Most recently touched wins — a client with two grants is applying to the current one.
    opps.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    return opps[0].id ?? null;
  } catch {
    return null;
  }
}

export interface FormIngestInput {
  contactId: string;
  formId?: string;
}

/** Turn one form submission into a Grant or Metrics activity (or explain why not). */
export async function ingestFormSubmission(
  input: FormIngestInput,
  opts: FormIngestOptions = {},
): Promise<FormIngestResult> {
  const client = opts.client ?? ghl();
  const base = { contactId: input.contactId, formId: input.formId };

  const route = await resolveRoute(FORM_SOURCE, [{ kind: 'form', id: input.formId }]);
  if (!route) {
    return { ...base, status: 'skipped', reason: 'no-route', detail: `form ${input.formId ?? '(none)'} has no routing rule` };
  }
  const routeInfo = { activityType: route.activityType, matchLabel: route.matchLabel };

  const contact = await getContact(input.contactId, client).catch(() => null);
  if (!contact) return { ...base, status: 'skipped', reason: 'no-contact', route: routeInfo };
  const companyId = (contact as any).businessId as string | undefined;
  if (!companyId) {
    return {
      ...base,
      status: 'skipped',
      reason: 'no-company',
      detail: `contact ${input.contactId} has no businessId — link the contact to its company, then re-run`,
      route: routeInfo,
    };
  }

  const [activityCatalog, contactCatalog] = await Promise.all([
    getCatalog(ACTIVITIES_OBJECT, { client }),
    getCatalog('contact', { client }),
  ]);
  const set = activityFieldSet(activityCatalog, route.activityType);
  const keys = new Set([...set.core, ...set.typeFields].map(bareKey));
  const values = mapContactValuesToActivity(contact as any, contactCatalog.byId as any, keys);

  const submittedAt = opts.submittedAt ?? new Date();
  let sourceRecordId: string;
  let period: string | undefined;
  // Which SOURCE owns this record's identity. Normally the form; for a grant it is the opportunity,
  // so the pipeline's record and this one are the same record.
  let keySource: ActivitySource = FORM_SOURCE as ActivitySource;

  if (route.activityType === 'metrics') {
    const p = reportingPeriodFor(submittedAt);
    period = p.end;
    values.reporting_period = p.end;
    values.activity_name = `Metrics – ${p.label}`;
    values.activity_date = p.end;
    sourceRecordId = `${input.contactId}:${p.end}`;
  } else {
    const pipelineId = String(route.defaults?.pipelineId ?? '');
    const oppId = pipelineId ? await findGrantOpportunity(input.contactId, pipelineId, client) : null;
    values.activity_date = values.activity_date ?? new Date(submittedAt).toISOString().slice(0, 10);
    // Same key the pipeline adapter uses, so the form's detail and the pipeline's status land on ONE
    // record. Without an opportunity we cannot know which grant this is, so key it by submission and
    // say so rather than inventing a second grant record.
    sourceRecordId = oppId ? `${oppId}:grant` : `${input.contactId}:${String(values.activity_date).slice(0, 10)}`;
    if (oppId) keySource = OPPORTUNITY_SOURCE as ActivitySource;
    if (!oppId) values.activity_notes = `Submitted with no matching ${pipelineId ? 'Direct Grants ' : ''}opportunity — link it to the grant pipeline record to merge the pipeline's status.`;
  }
  for (const k of Object.keys(values)) if (values[k] === undefined) delete values[k];

  if (!Object.keys(values).length) {
    return { ...base, status: 'skipped', reason: 'no-values', detail: 'the contact holds none of this type\'s fields', route: routeInfo };
  }

  if (opts.dryRun) {
    return { ...base, status: 'ingested', route: routeInfo, copied: Object.keys(values).length, reportingPeriod: period, detail: `would write ${Object.keys(values).length} field(s) for company ${companyId} (key ${keySource}/${sourceRecordId})` };
  }

  const activity = await upsertActivity(
    { source: keySource, sourceRecordId },
    { type: route.activityType, companyId, contactIds: [input.contactId], values },
    { ...opts, mode: 'ingest', actorKind: 'sync' },
  );
  return { ...base, status: 'ingested', route: routeInfo, copied: Object.keys(values).length, reportingPeriod: period, activity };
}
