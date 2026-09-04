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
  /** Declared key-mismatch aliases that FIRED — see FIELD_ALIASES. Present only when non-empty, so a
   *  rename that breaks one shows up as this disappearing rather than as a value quietly going missing. */
  aliases?: Array<{ from: string; to: string; note: string }>;
  reportingPeriod?: string;
  activity?: UpsertActivityResult;
}

export interface FormIngestOptions extends CreateActivityOptions {
  dryRun?: boolean;
  /** When the form was submitted. Defaults to now; a backfill should pass the real date. */
  submittedAt?: Date | string;
}

/**
 * One declared exception to key-matching: a contact field whose key differs from its activity twin.
 *
 * `values` optionally re-maps the VALUE too, for a pair whose option sets differ.
 */
export interface FieldAlias {
  /** Bare contact key, e.g. 'direct_grant_program'. */
  from: string;
  /** Bare activity key, e.g. 'grant_program'. */
  to: string;
  /** Why this pair does not key-match — kept in the table so nobody has to guess later. */
  note: string;
  /** Optional value translation, keyed by the contact's option KEY (GHL stores keys, not labels). */
  values?: Record<string, string>;
}

/**
 * THE ALIAS TABLE — the documented exceptions to key-matching.
 *
 * ⚠️ WHY THIS EXISTS, and why it is short on purpose. The derived map below is the RULE: ~90% of the
 * activity object's fields were lifted from the contact's, so they share a key and copy for free with
 * nothing to maintain. The failure mode is that a pair differing by even one character does not
 * match, and **nothing says so** — the value is simply never copied, on every submission, forever.
 *
 * Three were found in two days, all by mapping a funder's spreadsheet column and asking where it
 * would land:
 *
 *   1. `bank_loans_received_in_the_last_6_months` — the activity field did not EXIST. Not an alias;
 *      created 2026-09-03 (`scripts-ts/add-bank-loan-field.ts`, id PIPQzCwc8WRU1xiY7QB7). Now
 *      key-matches and needs no entry here.
 *   2. `direct_grant_program` → `grant_program` — different key AND different option sets.
 *   3. `expense_category_item3` → `expense_category_item_3` — a missing underscore, so item 3's
 *      expense category was dropped on every grant submission. Visible on every live record as the
 *      one blank category among ten.
 *
 * Additions should be rare and each should say why. If this table grows past a handful, the right
 * fix is renaming the contact field, not extending the exceptions.
 */
export const FIELD_ALIASES: FieldAlias[] = [
  {
    from: 'direct_grant_program',
    to: 'grant_program',
    note: 'different key; the contact offers BAF where the activity offers Gateway (see values)',
    // Zach, 2026-09-03: "BAF is Gateway. BAF is a funding type for grants but it's under the umbrella
    // of Gateway. Every company who gets BAF is eligible for Gateway reporting." So this is not a
    // lossy fold — BAF grants ARE Gateway grants, and `grant-definitions.md` records the eligibility
    // consequence as dimension D12.
    values: { baf: 'Gateway', sbsh: 'SBSH', trusted_connector: 'Trusted Connector' },
  },
  {
    from: 'expense_category_item3',
    to: 'expense_category_item_3',
    note: 'the contact field is missing an underscore, so item 3 never matched its activity twin',
  },
];

/** contact bare key → its alias entry. */
const ALIAS_BY_FROM = new Map(FIELD_ALIASES.map((a) => [a.from, a]));

/** Fold an option value to a comparable token, so a KEY or a LABEL both resolve. */
const optionToken = (v: unknown) =>
  String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Apply an alias's value translation, if it has one. Unlisted values pass through untouched. */
export function translateAliasValue(alias: FieldAlias, value: unknown): unknown {
  if (!alias.values) return value;
  const hit = alias.values[optionToken(value)];
  return hit ?? value;
}

/**
 * The contact's values for the fields this activity type has, keyed by the ACTIVITY's bare key.
 *
 * Matching is by key, which is reliable precisely because the object's fields were lifted from the
 * contact's. Anything without a counterpart is simply absent — never guessed at by name similarity,
 * which would silently mis-file a number into the wrong funder metric. The one exception is
 * FIELD_ALIASES above: a small, declared table of pairs whose keys differ, applied only after the
 * direct match fails.
 *
 * `onAlias` is called for every alias that actually fires, so a caller can LOG it — a field rename
 * that breaks an alias should be loud, not another silent drop.
 */
export function mapContactValuesToActivity(
  contact: { customFields?: Array<{ id: string; value?: unknown }> },
  contactCatalogById: Record<string, { fieldKey: string }>,
  activityFieldKeys: Set<string>,
  onAlias?: (alias: FieldAlias, value: unknown) => void,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const isBlank = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
  for (const cf of contact.customFields ?? []) {
    const def = contactCatalogById[cf.id];
    if (!def?.fieldKey) continue;
    const key = def.fieldKey.replace(/^contact\./, '');
    const v = cf.value;
    if (isBlank(v)) continue;

    // The rule first: an exact key match always wins over an alias.
    if (activityFieldKeys.has(key)) {
      if (NEVER_COPY.has(key)) continue;
      out[key] = v;
      continue;
    }

    // Then the declared exceptions. An alias only applies when the TARGET is a real field on this
    // activity type — otherwise a grant alias would fire while mapping a metrics snapshot.
    const alias = ALIAS_BY_FROM.get(key);
    if (!alias || NEVER_COPY.has(alias.to) || !activityFieldKeys.has(alias.to)) continue;
    // Don't let an alias overwrite a value the direct match already produced.
    if (!isBlank(out[alias.to])) continue;
    const translated = translateAliasValue(alias, v);
    out[alias.to] = translated;
    onAlias?.(alias, translated);
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
  // Record every alias that fires. A silently-dropped field is what the table exists to prevent, so
  // the aliases themselves must never become the new silent thing: they are reported on the result
  // and in the change-log rationale, which is what makes a future field rename loud.
  const aliasesUsed: Array<{ from: string; to: string; note: string }> = [];
  const values = mapContactValuesToActivity(
    contact as any, contactCatalog.byId as any, keys,
    (a) => aliasesUsed.push({ from: a.from, to: a.to, note: a.note }),
  );

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

  // Dry runs PLAN through upsertActivity (plan:true) rather than stopping short, so a backfill's
  // review distinguishes real updates from no-ops instead of restating the field count every time.
  const activity = await upsertActivity(
    { source: keySource, sourceRecordId },
    { type: route.activityType, companyId, contactIds: [input.contactId], values },
    { ...opts, mode: 'ingest', actorKind: 'sync', plan: opts.dryRun },
  );
  return {
    ...base, status: 'ingested', route: routeInfo, copied: Object.keys(values).length,
    ...(aliasesUsed.length ? { aliases: aliasesUsed } : {}),
    reportingPeriod: period, activity,
    ...(opts.dryRun
      ? { detail: `${activity.outcome}${activity.written.length ? `: ${activity.written.length} field(s)` : ''} for company ${companyId} (key ${keySource}/${sourceRecordId})` }
      : {}),
  };
}
