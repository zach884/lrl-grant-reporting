// The Gateway import's rules. The seven periods are ASSERTED rather than trusted: the period is half
// of the idempotency key, so a silent change to the derivation would either collide two submissions
// into one record or give one client two snapshots for the same half-year.
// Brief: docs/sprints/gateway-metrics-import.md.

import { describe, it, expect } from 'vitest';
import { planSnapshot, snapshotKey, FIELD_MAP, type GatewayRow } from '../sources/gatewayMetrics';
import { reportingPeriodFor } from '../reportingPeriod';

const row = (over: Partial<GatewayRow> = {}): GatewayRow => ({
  source_slug: 'gateway-apr-2023',
  workbook: 'Apr2023_LeanRocketLab_Company Metrics- NAICS (1).xlsx',
  submitted_at: '2023-04-15',
  row: 5,
  company_name: 'Adaxius Corp',
  email: 'zeng@adaxius.com',
  products_commercialized: null,
  products_in_pipeline: null,
  jobs_created: null,
  jobs_retained: null,
  medc_funding: null,
  federal_funding: null,
  venture_capital: null,
  angel_funding: null,
  bank_loans: null,
  owner_investment: null,
  new_sales: null,
  other_funding: null,
  other_explanation: null,
  ...over,
});

describe('the seven Gateway periods', () => {
  // Gateway's April/October cadence lands exactly on the Feb-end/Aug-end boundaries the existing
  // function already knows, which is why this import adds NO period logic of its own.
  const EXPECTED: Array<[string, string, string]> = [
    ['2023-04-15', '2023-02-28', 'Sep 2022–Feb 2023'],
    ['2023-10-15', '2023-08-31', 'Mar–Aug 2023'],
    ['2024-04-15', '2024-02-29', 'Sep 2023–Feb 2024'],
    ['2024-10-15', '2024-08-31', 'Mar–Aug 2024'],
    ['2025-04-15', '2025-02-28', 'Sep 2024–Feb 2025'],
    ['2025-10-15', '2025-08-31', 'Mar–Aug 2025'],
    ['2026-04-15', '2026-02-28', 'Sep 2025–Feb 2026'],
  ];

  it.each(EXPECTED)('a workbook submitted %s covers the window ending %s', (submitted, end, label) => {
    const p = reportingPeriodFor(submitted);
    expect(p.end).toBe(end);
    expect(p.label).toBe(label);
  });

  it('yields seven DISTINCT periods, so no two workbooks can collide', () => {
    const ends = EXPECTED.map(([s]) => reportingPeriodFor(s).end);
    expect(new Set(ends).size).toBe(7);
  });

  it('none of them is the live 2026-09-02 snapshot period', () => {
    // The snapshot created on 2026-09-02 sits in the window ending 2026-08-31. If any workbook
    // derived that period, the import would overwrite a real submission with spreadsheet history.
    const live = reportingPeriodFor('2026-09-02').end;
    expect(live).toBe('2026-08-31');
    expect(EXPECTED.map(([s]) => reportingPeriodFor(s).end)).not.toContain(live);
  });
});

describe('planSnapshot', () => {
  it('stamps the derived period on the record three ways', () => {
    const p = planSnapshot(row({ jobs_created: 2 }))!;
    expect(p.periodEnd).toBe('2023-02-28');
    expect(p.values.reporting_period).toBe('2023-02-28');
    expect(p.values.activity_date).toBe('2023-02-28');
    expect(p.values.activity_name).toBe('Metrics – Sep 2022–Feb 2023');
  });

  it('maps every Gateway figure to its activity field', () => {
    const p = planSnapshot(row({
      products_commercialized: 0, products_in_pipeline: 1, jobs_created: 2, jobs_retained: 4,
      medc_funding: 5000, federal_funding: 250000, venture_capital: 1_000_000, angel_funding: 75_000,
      bank_loans: 40_000, owner_investment: 12_500, new_sales: 300_000, other_funding: 900,
      other_explanation: 'State pilot award',
    }))!;
    expect(p.values.number_of_new_products_commercialized_in_the_last_6_months).toBe(0);
    expect(p.values.number_of_products_in_the_commercialization_pipeline).toBe(1);
    expect(p.values.jobs_created_in_the_last_6_months).toBe(2);
    expect(p.values.jobs_retained_in_the_last_6_months).toBe(4);
    expect(p.values.medc_funding_received_in_the_last_6_months).toBe(5000);
    expect(p.values.federal_funding_including_sbir_and_sttr_received_in_the_last_6_months).toBe(250000);
    expect(p.values.venture_capital_funding_received_in_the_last_6_months).toBe(1_000_000);
    // "angle", not "angel" — the live field key is misspelled and the key that exists is the one bound.
    expect(p.values.angle_investor_funding_received_in_the_last_6_months).toBe(75_000);
    expect(p.values.bank_loans_received_in_the_last_6_months).toBe(40_000);
    expect(p.values.owner_investment_in_the_last_6_months).toBe(12_500);
    expect(p.values.new_sales_in_the_last_6_months).toBe(300_000);
    expect(p.values.other_funding_received_in_the_last_6_months).toBe(900);
    expect(p.values.describe_other_funding_received).toBe('State pilot award');
    expect(p.reported).toBe(13);
  });

  it('carries the bank/loan figure into its own field, never into "other"', () => {
    // Merging bank debt into `other_funding` would make both figures wrong while still reconciling
    // to the right grand total — the error that survives review.
    const p = planSnapshot(row({ bank_loans: 40_000 }))!;
    expect(p.values.bank_loans_received_in_the_last_6_months).toBe(40_000);
    expect(p.values.other_funding_received_in_the_last_6_months).toBeUndefined();
  });

  it('treats a reported zero as a figure, not a blank', () => {
    // Gateway's own instruction is to enter 0, so "we raised nothing" and "we did not report" are
    // different answers and must not collapse into one.
    const p = planSnapshot(row({ jobs_created: 0, venture_capital: 0 }))!;
    expect(p.values.jobs_created_in_the_last_6_months).toBe(0);
    expect(p.reported).toBe(2);
  });

  it('returns null for a row that reports nothing at all', () => {
    expect(planSnapshot(row())).toBeNull();
  });

  it('records the workbook and submission date as provenance, not as identity', () => {
    const p = planSnapshot(row({ jobs_created: 1 }))!;
    expect(p.values.activity_notes).toContain('submitted 2023-04-15');
    expect(p.values.activity_notes).toContain('row 5');
  });

  it('writes no company attributes onto the activity', () => {
    // NAICS and address belong to the company record, whose enrichers own their provenance. A copy
    // on the activity would be a second, staler answer to the same question.
    const p = planSnapshot(row({ jobs_created: 1 }))!;
    const keys = Object.keys(p.values);
    for (const k of ['naics', 'address', 'city', 'state', 'postal_code', 'zip']) {
      expect(keys.some((x) => x.includes(k))).toBe(false);
    }
  });
});

describe('snapshotKey', () => {
  it('is exactly the key the Client Reporting form adapter computes', () => {
    // Identity is (source, source_record_id). Claiming the form's key means a real submission for
    // one of these periods UPDATES the imported snapshot instead of creating a second one.
    expect(snapshotKey('abc123', '2023-02-28')).toBe('abc123:2023-02-28');
  });

  it('separates two periods for the same contact, and two contacts in one period', () => {
    expect(snapshotKey('abc', '2023-02-28')).not.toBe(snapshotKey('abc', '2023-08-31'));
    expect(snapshotKey('abc', '2023-02-28')).not.toBe(snapshotKey('xyz', '2023-02-28'));
  });
});

describe('FIELD_MAP', () => {
  it('maps each workbook field once and each activity field once', () => {
    const from = FIELD_MAP.map(([f]) => f);
    const to = FIELD_MAP.map(([, t]) => t);
    expect(new Set(from).size).toBe(from.length);
    expect(new Set(to).size).toBe(to.length);
  });
});
