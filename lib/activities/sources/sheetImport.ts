// lib/activities/sources/sheetImport.ts — historical activities from the workflow-written grant
// spreadsheets (`Past Grant Reports/Trusted Connector Report.xlsx`, `SBSH Companies Served…xlsx`).
//
// WHY THIS EXISTS. Appointment ingestion only ever sees meetings booked through routed GHL links.
// Most of LRL's technical assistance ran on other links, or on Google Calendar, and was written up by
// hand into these sheets by a GHL workflow. Measured 2026-08-31: the TC sheet holds **271 one-on-one
// TA rows where GHL holds 15**. Trusted Connector's required KPI 7 is not computable without them.
//
// This is a ONE-TIME import of history, not a pipeline. Ongoing capture is the webhooks plus
// nightly-activities.yml. The xlsx→JSON step lives in `scripts/extract-sheet-rows.py` so the app
// takes no spreadsheet dependency and so a person can read what was parsed before anything is
// written to live.
//
// Design decided with Zach 8/31, and every rule below is measured rather than assumed — see
// docs/sprints/sheet-import.md.

import { normalizeCompanyName, namesLookAlike } from '../../sync/identityGuard';

/** One extracted spreadsheet row, as `scripts/extract-sheet-rows.py` emits it. */
export interface SheetRow {
  source_slug: string;
  row: number;
  business_name: string;
  owner_name?: string | null;
  email?: string | null;
  date_added?: string | null;
  county?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  notes?: string | null;
  flags: Record<string, boolean>;
  grant_amount?: number | string | null;
  grant_date?: string | null;
  referral_reason?: string | null;
  /** The referral TARGET, in whichever of the named columns holds it. */
  referral_capital_provider?: string | null;
  referral_sb_partner?: string | null;
  referral_other?: string | null;
  referral_mentor?: string | null;
  referral_other_sbsh?: string | null;
  referral_misbdc?: string | null;
  referral_smartzone?: string | null;
}

/**
 * Referral target column → the `referral_type` option it means, in the order a row is read.
 *
 * ⚠️ `referral_sb_partner` maps to `Other` because the object has **no "Ecosystem Partner" option** —
 * a gap already flagged in funder-field-trace.md §6.6, and one that blocks TC's required KPI 16
 * ("Referrals to other Small Business Ecosystem Partners") until the option is appended. The
 * counterparty NAME is preserved either way, so nothing is lost by importing now and re-typing later.
 */
const REFERRAL_TARGETS: Array<[keyof SheetRow, string, string]> = [
  ['referral_capital_provider', 'Capital Provider', 'capital'],
  ['referral_mentor', 'Mentor', 'mentor'],
  ['referral_other_sbsh', 'Other SBSH', 'sbsh'],
  ['referral_misbdc', 'MI-SBDC', 'misbdc'],
  ['referral_smartzone', 'SmartZone', 'smartzone'],
  ['referral_sb_partner', 'Other', 'ecosystem'],
  ['referral_other', 'Other', 'other'],
];

/** What one row asks us to create. A row can produce more than one. */
export interface PlannedActivity {
  /** Deterministic idempotency key half — `tc-cumulative:row-47` or `…:row-47:group`. */
  sourceRecordId: string;
  activityType: 'intake' | 'technical_assistance' | 'introduction_referral';
  values: Record<string, unknown>;
  /** `exact` when the row came from a real appointment; `approximate` when hand-entered later. */
  dateConfidence: 'exact' | 'approximate';
}

export interface RowPlan {
  row: SheetRow;
  activities: PlannedActivity[];
  /** Set when the row produces nothing. */
  skip?: string;
}

/** Business names that identify nobody. Measured: 7 such rows in the TC sheet. */
const UNUSABLE_NAMES = new Set(['unsure', 'unknown', 'n/a', 'na', 'none', '']);

/**
 * A row written from a real GHL appointment carries the appointment TITLE in its notes, separated by
 * a pipe: `Intake Meeting with Jay Mitchell | wants to…`. That marker is the only reliable signal of
 * whether the date can be trusted.
 *
 * Measured 2026-08-31: 136 of 375 TC rows carry it, spread over 63 dates with at most 10 on any one
 * day. The rows WITHOUT it cluster on 27-, 23- and 22-row days — including a quarter end and a year
 * end — which is Alex writing up notes after the fact. Crucially, cluster SIZE is the wrong test:
 * 2026-01-28 has 10 rows and all 10 are titled, a genuinely busy day that a size filter would throw
 * away.
 */
export function dateConfidence(notes: string | null | undefined): 'exact' | 'approximate' {
  return String(notes ?? '').includes('|') ? 'exact' : 'approximate';
}

/**
 * Is this 1:1 row an intake meeting rather than general assistance?
 *
 * The notes name the appointment, so this reads the title rather than guessing. Corroborated two
 * ways: of the 80 in-range rows matching this, 63 have a GHL intake activity on the exact same date;
 * and 80 of the 84 matches fall on a Wednesday, which is when LRL runs intakes.
 */
export function looksLikeIntake(notes: string | null | undefined): boolean {
  return /intake\s+(meeting|call)|initial\s+meeting/i.test(String(notes ?? ''));
}

/**
 * `Reason for grant` was computed by a GHL workflow's ChatGPT step reading the contact's expense line
 * items — but it fired while those were still blank, so the model correctly reported it had nothing to
 * summarise and the apology was stored as data. Never import an apology as a reason.
 */
export function isAiFailureText(text: string | null | undefined): boolean {
  const t = String(text ?? '');
  if (t.length < 40) return false;
  return /line[- ]item/i.test(t) && /(blank|no content|cannot|could not|please (supply|provide))/i.test(t);
}

/** Trim the AI apology out, and mark a hand-entered date so a reader knows not to trust the day. */
function buildNotes(row: SheetRow, confidence: 'exact' | 'approximate'): string | undefined {
  const parts: string[] = [];
  const notes = String(row.notes ?? '').trim();
  if (notes && !isAiFailureText(notes)) parts.push(notes);
  if (confidence === 'approximate') {
    parts.push(`[imported from ${row.source_slug} row ${row.row}; date approximate — entered after the fact]`);
  } else {
    parts.push(`[imported from ${row.source_slug} row ${row.row}]`);
  }
  const joined = parts.join('\n\n').trim();
  return joined || undefined;
}

/**
 * Turn one spreadsheet row into the activities it represents.
 *
 * A row is normally single-type — measured: 253 pure 1:1 TA, 65 pure referral, 39 pure group, 11
 * with a grant, 7 spanning 1:1 and group — so an intake and a referral on the same day are two rows
 * and never need untangling. Where a row DOES carry two service flags it yields two activities with
 * distinct keys, rather than silently reporting one of them.
 *
 * GRANTS ARE DELIBERATELY NOT CREATED HERE. The pipeline already holds 63 grant activities keyed on
 * the opportunity, and the grant capture design is still open (contract execution as the trigger).
 * Importing grant rows would duplicate what exists and bake in a decision not yet made. A row whose
 * only content is a grant is skipped and reported.
 */
export function planRow(row: SheetRow): RowPlan {
  const name = String(row.business_name ?? '').trim();
  if (UNUSABLE_NAMES.has(name.toLowerCase())) {
    return { row, activities: [], skip: 'unusable-business-name' };
  }
  if (!row.date_added) return { row, activities: [], skip: 'no-date' };

  const confidence = dateConfidence(row.notes);
  const notes = buildNotes(row, confidence);
  const base = {
    activity_date: row.date_added,
    ...(notes ? { activity_notes: notes } : {}),
  };
  const key = (suffix?: string) => `${row.source_slug}:row-${row.row}${suffix ? `:${suffix}` : ''}`;

  const activities: PlannedActivity[] = [];
  const f = row.flags ?? {};

  if (f.flag_referral) {
    // One activity per NAMED target. Four referral rows for one company on one day looked like a
    // duplicated row until the target columns were read — they were referrals to Tanesia Greer,
    // Todd Vanappledorn, Tommy Harris and Shawn Prissle. The counterparty is part of the identity.
    const targets = REFERRAL_TARGETS
      .map(([field, type, slug]) => ({ name: String(row[field] ?? '').trim(), type, slug }))
      .filter((t) => t.name);
    if (targets.length) {
      for (const t of targets) {
        activities.push({
          sourceRecordId: key(`referral:${t.slug}`),
          activityType: 'introduction_referral',
          dateConfidence: confidence,
          values: {
            ...base,
            activity_name: `Referral – ${name} → ${t.name}`,
            referral_type: [t.type],
            counterparty_name: t.name,
            ...(row.referral_reason ? { referral_reason: row.referral_reason } : {}),
          },
        });
      }
    } else {
      // Flagged as a referral with no target recorded. Still a real event, just unattributed.
      activities.push({
        sourceRecordId: key('referral'),
        activityType: 'introduction_referral',
        dateConfidence: confidence,
        values: {
          ...base,
          activity_name: `Referral – ${name}`,
          ...(row.referral_reason ? { referral_reason: row.referral_reason } : {}),
        },
      });
    }
  }

  // Group delivery. Zach (8/29): "TA Group for now is like workshops that we run." Those live in Wix
  // Events going forward, but a historical row has no event record to attach to — so it imports as
  // technical assistance with modality=group, which is what TC's small-group KPI actually counts.
  if (f.flag_group) {
    activities.push({
      sourceRecordId: key('group'),
      activityType: 'technical_assistance',
      dateConfidence: confidence,
      values: { ...base, activity_name: `Group Technical Assistance – ${name}`, modality: 'group' },
    });
  }

  if (f.flag_one_on_one || f.flag_support) {
    const intake = looksLikeIntake(row.notes);
    activities.push({
      sourceRecordId: key(intake ? 'intake' : 'ta'),
      activityType: intake ? 'intake' : 'technical_assistance',
      dateConfidence: confidence,
      values: {
        ...base,
        activity_name: intake ? `Intake – ${name}` : `Technical Assistance – ${name}`,
        ...(intake ? {} : { modality: 'one_on_one' }),
      },
    });
  }

  if (!activities.length) {
    const hasGrant = row.grant_amount != null && row.grant_amount !== '';
    return { row, activities: [], skip: hasGrant ? 'grant-only (covered by the pipeline)' : 'no-service-flag' };
  }
  return { row, activities };
}

// ── company identity ──────────────────────────────────────────────────────────────────────────────

export type CompanyVerdict =
  | { kind: 'match'; companyId: string; reason: string }
  | { kind: 'review'; companyId: string | null; reason: string }
  | { kind: 'create'; reason: string };

/**
 * Does the company the contact currently belongs to match the business this row names?
 *
 * `contact.businessId` is a POINT-IN-TIME value: it names where the person is now, not who was served
 * when the activity happened. Zach's case (8/31): *"Jessica Wade has 2 companies. Her primary is now
 * Bailey & Co. But before it was something else and that old company is not in the system but should
 * be for reporting purposes with the activities associated."*
 *
 * ⚠️ **This deliberately does NOT try to decide a disagreement.** A fuzzy comparison cannot separate a
 * rename from a job change — `Motion Sync` → `Motion Sync Technologies Inc` is the same business while
 * `Solution Consulting Team` → `JENDAMARK USA` is a different one, and both look identical to a string
 * comparison. Measured: of 17 flagged disagreements, ~13 were renames. So a disagreement is a REVIEW
 * ITEM for a person, never an automatic decision — the same rule `resourceRelations.ts` follows.
 */
export function judgeCompany(
  sheetName: string,
  primaryCompanyId: string | null,
  primaryCompanyName: string | null,
  contactPersonName?: string | null,
): CompanyVerdict {
  if (!primaryCompanyId || !primaryCompanyName) {
    return { kind: 'create', reason: 'contact has no company' };
  }
  const a = normalizeCompanyName(sheetName);
  const b = normalizeCompanyName(primaryCompanyName);
  if (namesLookAlike(a, b)) {
    return { kind: 'match', companyId: primaryCompanyId, reason: 'sheet name matches the contact’s company' };
  }
  // The sheet sometimes records the PERSON rather than the business — "Carrie Joers - Self Employed",
  // whose company is really "The Artful Eye, LLC". A name that is the person's own name carries no
  // information about the business, so it cannot contradict the link.
  const person = normalizeCompanyName(contactPersonName ?? '');
  if (person && namesLookAlike(a, person)) {
    return { kind: 'match', companyId: primaryCompanyId, reason: 'sheet recorded the person, not the business' };
  }
  if (/self[\s-]*employ|sole[\s-]*propriet/i.test(sheetName)) {
    return { kind: 'match', companyId: primaryCompanyId, reason: 'sheet recorded a sole proprietor' };
  }
  return {
    kind: 'review',
    companyId: primaryCompanyId,
    reason: `sheet says "${sheetName}" but the contact’s company is "${primaryCompanyName}" — rename or a different business?`,
  };
}
