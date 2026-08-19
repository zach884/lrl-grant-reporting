// lib/activities/create.ts — the ONE way an activity gets logged.
//
// "Log the interaction once" only works if every logged interaction is (a) attached to the company
// it happened to, and (b) visible in the change log like every other write the app makes. v1 did
// neither: it associated the CONTACT only, so an activity could not be counted for its company —
// which is what every funder report aggregates by — and it wrote nothing to the audit sink.
//
// Order matters. The record is created first (it is the thing being logged), then the associations,
// then the log line. An association failure is REPORTED, never swallowed: a company-less activity is
// invisible to reporting, so "saved" with a broken link is the one outcome worse than an error.

import { GhlClient, ghl } from '../ghl/client';
import { getCatalog } from '../ghl/catalogCache';
import { createObjectRecord } from '../ghl/createRecord';
import { createRelation, resolveAssociationId } from '../ghl/associations';
import { getBusinessRecord } from '../ghl/businesses';
import { logChange } from '../audit/log';
import type { ChangeLogFieldChange } from '../audit/types';
import {
  ACTIVITIES_OBJECT,
  activityType,
  defaultActivityName,
  validateActivityInput,
  type ActivityInput,
  type ActivityWriteMode,
} from './schema';

/** Association keys this module links through, resolved by key (never hardcoded ids). */
export const COMPANY_ACTIVITY_KEY = 'company_activity';
export const ACTIVITY_CONTACT_KEY = 'activity_contact';
export const REFERRED_TO_KEY = 'referral_received_referred_to';

export interface ActivityLinkResult {
  /** Which association was attempted. */
  key: string;
  /** The record linked to the activity (company or contact id). */
  recordId: string;
  status: 'linked' | 'failed';
  reason?: string;
}

export interface CreateActivityResult {
  recordId: string;
  /** Fields verified as stored on the new record. */
  written: string[];
  /** Fields that didn't make it, with GHL's reason. */
  skipped: Array<{ key: string; reason: string }>;
  links: ActivityLinkResult[];
  activityName: string;
  companyName?: string;
}

export class ActivityValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`activity input rejected: ${errors.join('; ')}`);
    this.name = 'ActivityValidationError';
    this.errors = errors;
  }
}

export interface CreateActivityOptions {
  /** Who logged it — the GHL iframe user. Recorded as the change-log actor. */
  actor?: { name?: string; email?: string; userId?: string };
  /** 'manual' (default) enforces the staff-entry completeness rules; 'ingest' records what happened. */
  mode?: ActivityWriteMode;
  /** Change-log actor kind. Ingestion adapters pass 'sync' so the log distinguishes them from people. */
  actorKind?: 'staff' | 'sync';
  client?: GhlClient;
}

/** Link `recordId` to the activity through the association with `key`. Reports, never throws. */
async function link(
  key: string,
  recordId: string,
  activityId: string,
  client: GhlClient,
): Promise<ActivityLinkResult> {
  try {
    const associationId = await resolveAssociationId(key, client);
    if (!associationId) {
      return { key, recordId, status: 'failed', reason: `no association definition with key "${key}" on this location` };
    }
    // Direction matters and is fixed by the definition: for all three of ours the activity is the
    // SECOND record (company/contact first) — see the association table in the sprint spec.
    await createRelation({ associationId, firstRecordId: recordId, secondRecordId: activityId }, client);
    return { key, recordId, status: 'linked' };
  } catch (e: any) {
    return { key, recordId, status: 'failed', reason: e?.message ?? String(e) };
  }
}

/**
 * Create one activity record, associate it, and log it.
 *
 * Throws `ActivityValidationError` when the input is incomplete (before writing anything) and
 * propagates a GHL failure on the record POST. Everything after the record exists is reported in
 * the result rather than thrown, so the caller can show the user exactly what did and didn't land.
 */
export async function createActivity(
  input: ActivityInput,
  opts: CreateActivityOptions = {},
): Promise<CreateActivityResult> {
  const client = opts.client ?? ghl();
  const catalog = await getCatalog(ACTIVITIES_OBJECT, { client });

  const errors = validateActivityInput(input, catalog, opts.mode ?? 'manual');
  if (errors.length) throw new ActivityValidationError(errors);

  const company = await getBusinessRecord(input.companyId, client);
  if (!company) throw new ActivityValidationError([`company ${input.companyId} not found`]);
  const companyName = String(company.properties?.name ?? '') || undefined;

  const actorName = opts.actor?.name?.trim() || opts.actor?.email?.trim() || 'staff';
  const activityName =
    String(input.values.activity_name ?? '').trim() ||
    defaultActivityName(input.type, companyName ?? '', input.values.activity_date);

  const values: Record<string, unknown> = {
    ...input.values,
    activity_type: input.type,
    activity_name: activityName,
    // Who logged it, on the record itself — the field exists and staff shouldn't have to type it.
    activity_owner: String(input.values.activity_owner ?? '').trim() || actorName,
  };

  const created = await createObjectRecord(ACTIVITIES_OBJECT, values, catalog.byKey, client);

  const links: ActivityLinkResult[] = [];
  links.push(await link(COMPANY_ACTIVITY_KEY, input.companyId, created.recordId, client));
  for (const contactId of input.contactIds ?? []) {
    links.push(await link(ACTIVITY_CONTACT_KEY, contactId, created.recordId, client));
  }
  if (input.referredToContactId) {
    links.push(await link(REFERRED_TO_KEY, input.referredToContactId, created.recordId, client));
  }

  const changes: ChangeLogFieldChange[] = created.written.map((key) => ({
    field: `${ACTIVITIES_OBJECT}.${key}`,
    to: created.coerced.properties[key],
  }));
  // Associations are part of what was written, and the failure mode we most need to see later.
  for (const l of links) {
    changes.push({
      field: `association.${l.key}`,
      to: l.recordId,
      ...(l.status === 'failed' ? { rationale: `link failed: ${l.reason}` } : {}),
    });
  }
  const failed = links.filter((l) => l.status === 'failed');
  await logChange({
    objectType: ACTIVITIES_OBJECT,
    recordId: created.recordId,
    recordLabel: activityName,
    actorKind: opts.actorKind ?? 'staff',
    actorName,
    action: 'create',
    changes,
    method: activityType(input.type)?.label,
    ...(failed.length ? { error: failed.map((l) => `${l.key}: ${l.reason}`).join('; ') } : {}),
  });

  return {
    recordId: created.recordId,
    written: created.written,
    skipped: created.skipped,
    links,
    activityName,
    companyName,
  };
}
