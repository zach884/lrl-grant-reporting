// lib/activities/sources/gatewayMetrics.ts — the seven Gateway semi-annual workbooks as DATED
// metrics snapshots.
//
// WHY THIS EXISTS. Gateway's outcome half was blocked almost entirely by having zero metrics
// records, and the contacts cannot supply the history: a contact holds only its MOST RECENT Client
// Reporting answers and records no submission date anywhere (every DATE-type contact field was
// checked). A contact-driven backfill could therefore only file every snapshot under one assumed
// period — fabricating history. Zach, 2026-09-02: *"I do not want to stamp all of our previous
// records to the current period."*
//
// These workbooks are the opposite kind of source: seven funder-submitted semi-annual reports, one
// row per company, already reconciled and sent to MEDC. Provenance does not get better than "the
// numbers we submitted". Design: docs/sprints/gateway-metrics-import.md.
//
// This is a ONE-TIME import of history. Ongoing capture is the Client Reporting form (webhook #3).

import { reportingPeriodFor } from '../reportingPeriod';

/** One extracted workbook row, as `scripts/extract-gateway-metrics.py` emits it. */
export interface GatewayRow {
  source_slug: string;
  workbook: string;
  /** The date the workbook was submitted FOR — the input to the period derivation. */
  submitted_at: string;
  row: number;
  company_name: string | null;
  email: string | null;
  products_commercialized: number | null;
  products_in_pipeline: number | null;
  jobs_created: number | null;
  jobs_retained: number | null;
  medc_funding: number | null;
  federal_funding: number | null;
  venture_capital: number | null;
  angel_funding: number | null;
  bank_loans: number | null;
  owner_investment: number | null;
  new_sales: number | null;
  other_funding: number | null;
  other_explanation: string | null;
}

/**
 * Workbook field → the activity field it means.
 *
 * Every Gateway figure is already "in the last 6 months", which is exactly what these fields mean —
 * no unit conversion and no re-basing. The company attributes in D/E–H (NAICS, address) are
 * deliberately absent: the company record owns those and the enrichers own their provenance, so
 * writing them onto an activity would create a second, staler copy.
 */
export const FIELD_MAP: Array<[keyof GatewayRow, string]> = [
  ['products_commercialized', 'number_of_new_products_commercialized_in_the_last_6_months'],
  ['products_in_pipeline', 'number_of_products_in_the_commercialization_pipeline'],
  ['jobs_created', 'jobs_created_in_the_last_6_months'],
  ['jobs_retained', 'jobs_retained_in_the_last_6_months'],
  ['medc_funding', 'medc_funding_received_in_the_last_6_months'],
  ['federal_funding', 'federal_funding_including_sbir_and_sttr_received_in_the_last_6_months'],
  ['venture_capital', 'venture_capital_funding_received_in_the_last_6_months'],
  // ⚠️ "angle", not "angel". The live field key is misspelled; bind the key that exists rather than
  // the one that reads correctly.
  ['angel_funding', 'angle_investor_funding_received_in_the_last_6_months'],
  ['bank_loans', 'bank_loans_received_in_the_last_6_months'],
  ['owner_investment', 'owner_investment_in_the_last_6_months'],
  ['new_sales', 'new_sales_in_the_last_6_months'],
  ['other_funding', 'other_funding_received_in_the_last_6_months'],
  ['other_explanation', 'describe_other_funding_received'],
];

/**
 * Gateway column V, "Bank/Loan", had nowhere to go until 2026-09-02.
 *
 * `contact.bank_loans_received_in_the_last_6_months` existed — the Client Reporting form asks the
 * question — but the activities object had no counterpart across all 108 fields. Since
 * `mapContactValuesToActivity` matches on bare key, there was no key to match: **every real Client
 * Reporting submission silently dropped the figure**, not just this import. Mapping Gateway's column
 * V is what surfaced it.
 *
 * It was NOT folded into `other_funding_received_in_the_last_6_months`. "Other" is a reported
 * category with its own explanation field, and a funder totals the columns; quietly merging bank debt
 * into it would make both figures wrong in a way that still reconciles to the right grand total —
 * the kind of error that survives review.
 *
 * The field now exists (`scripts-ts/add-bank-loan-field.ts`, id PIPQzCwc8WRU1xiY7QB7), created as
 * NUMERICAL in the same folder as its seven siblings so the report engine aggregates it with them.
 */

export interface PlannedSnapshot {
  /** `<contactId>:<periodEnd>` is filled in by the runner, which is what knows the contact. */
  periodEnd: string;
  periodLabel: string;
  values: Record<string, unknown>;
  /** How many figures the row actually reported. A row of all-blanks is not a snapshot. */
  reported: number;
}

/**
 * Turn one workbook row into the metrics snapshot it represents, or null if it reports nothing.
 *
 * The period comes from `reportingPeriodFor(submitted_at)` — the SAME function the Client Reporting
 * form adapter uses. Gateway's April/October cadence lands exactly on the Feb-end/Aug-end boundaries
 * that function already knows, so this import adds no period logic of its own. That matters because
 * the period is half of the idempotency key: derive it two ways and you get either a collision or a
 * second snapshot for one half-year, and a follow-on-funding figure counted twice still looks
 * plausible on review.
 */
export function planSnapshot(row: GatewayRow): PlannedSnapshot | null {
  const p = reportingPeriodFor(row.submitted_at);
  const values: Record<string, unknown> = {};
  let reported = 0;

  for (const [from, to] of FIELD_MAP) {
    const v = row[from];
    if (v == null || v === '') continue;
    values[to] = v;
    reported += 1;
  }

  // A reported zero is a reported figure — Gateway's own instruction is to enter 0 — so `reported`
  // counts zeros. What it must not count is a padding row, and those arrive with every cell empty.
  if (!reported) return null;

  values.reporting_period = p.end;
  values.activity_date = p.end;
  values.activity_name = `Metrics – ${p.label}`;

  const provenance = [
    `[imported from the Gateway semi-annual report submitted ${row.submitted_at}`,
    `(${row.workbook}, row ${row.row})]`,
  ].join(' ');
  values.activity_notes = provenance;

  return {
    periodEnd: p.end,
    periodLabel: p.label,
    values,
    reported,
  };
}

/**
 * The idempotency key half that identifies a snapshot: the SAME key `sources/form.ts` computes.
 *
 * Activity identity is (source, source_record_id) — both halves — and this deliberately claims the
 * form's key with source `Form`. The consequence is the desired one: if a real Client Reporting
 * submission ever covers one of these seven periods, it UPDATES the imported snapshot instead of
 * creating a second one for the same half-year.
 *
 * ⚠️ A tidier-looking `gateway-<period>:row-N` was rejected. It reads better and it silently permits
 * one duplicate per period per company. Provenance is a field (`activity_notes`), not an identity.
 */
export const snapshotKey = (contactId: string, periodEnd: string) => `${contactId}:${periodEnd}`;
