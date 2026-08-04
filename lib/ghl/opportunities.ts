// lib/ghl/opportunities.ts — create/update the monthly Cafe Fuel sales opportunity.
//
// Verified live 2026-08-04 against the Cafe Fuel Sales pipeline:
//   - POST /opportunities/            create (locationId required in body)
//   - PUT  /opportunities/{id}        partial update (preserves contact/pipeline/stage)
//   - DATE custom field writes as customFields:[{ id, field_value:"YYYY-MM-DD" }]
//     (the epoch-number form is rejected 400). Stored as midnight-UTC epoch.
//   - search endpoint returns the date as fieldValueDate (epoch ms); single GET as
//     fieldValue ("YYYY-MM-DD"). We read back via search for the epoch cross-check.

import { GhlClient, ghl } from './client';

// ---- Cafe Fuel constants (overridable via env for portability) -----------
export const CAFE_FUEL = {
  pipelineId: process.env.CAFE_FUEL_PIPELINE_ID || 'Oy8dY3tzl1j6abqSOVAX',
  stageId: process.env.CAFE_FUEL_STAGE_ID || '0aab8c79-a013-4362-8584-91c4f1d1a575',
  dateFieldId: process.env.CAFE_FUEL_DATE_FIELD_ID || 'y90ihzM5zO5rZg4G20ff',
  contactId: process.env.CAFE_FUEL_CONTACT_ID || '6ie3mjIAEcvaE8rHYsgY', // Faith Seneff / Cafe Fuel
  status: process.env.CAFE_FUEL_OPP_STATUS || 'won',
} as const;

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const pad = (n: number) => String(n).padStart(2, '0');

export function monthLabel(year: number, month: number): string {
  return `${MONTHS[month - 1]} ${year}`;
}
/** Opportunity name convention: "Cafe Fuel | January 2026 Sales". */
export function opportunityName(year: number, month: number): string {
  return `Cafe Fuel | ${monthLabel(year, month)} Sales`;
}
export function lastDayOfMonthISO(year: number, month: number): string {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad(month)}-${pad(lastDay)}`;
}
export function lastDayEpochMs(year: number, month: number): number {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Date.UTC(year, month - 1, lastDay);
}

export interface MonthlyOpp {
  id: string;
  name: string;
  monetaryValue: number;
  dateEpochMs: number | null;
}

/** Read all opportunities in the Cafe Fuel pipeline (small; single page suffices). */
export async function listCafeFuelOpps(client: GhlClient = ghl()): Promise<MonthlyOpp[]> {
  const res = await client.request<any>({
    path: '/opportunities/search',
    params: { location_id: client.locationId, pipeline_id: CAFE_FUEL.pipelineId, limit: 100 },
    autoLocation: false,
  });
  return (res.opportunities ?? []).map((o: any): MonthlyOpp => {
    let epoch: number | null = null;
    for (const cf of o.customFields ?? []) {
      if (cf.id === CAFE_FUEL.dateFieldId && typeof cf.fieldValueDate === 'number') epoch = cf.fieldValueDate;
    }
    return { id: o.id, name: o.name, monetaryValue: o.monetaryValue, dateEpochMs: epoch };
  });
}

/** Find the opportunity for a month — match on the reporting-month date first, name second. */
export async function findMonthlyOpportunity(
  year: number, month: number, client: GhlClient = ghl(),
): Promise<MonthlyOpp | null> {
  const opps = await listCafeFuelOpps(client);
  const targetEpoch = lastDayEpochMs(year, month);
  const targetName = opportunityName(year, month).toLowerCase();
  return (
    opps.find((o) => o.dateEpochMs === targetEpoch) ??
    opps.find((o) => (o.name ?? '').toLowerCase() === targetName) ??
    null
  );
}

export interface UpsertResult {
  action: 'create' | 'update';
  id?: string;
  name: string;
  monetaryValue: number;
  dateISO: string;
  payload: Record<string, unknown>;
  dryRun: boolean;
}

/**
 * Create or update the monthly Cafe Fuel opportunity with the given net-sales value.
 * Idempotent: matches an existing month (by date, then name) and updates it in place.
 */
export async function upsertMonthlyOpportunity(
  args: { year: number; month: number; monetaryValue: number; dryRun?: boolean; client?: GhlClient },
): Promise<UpsertResult> {
  const client = args.client ?? ghl();
  const dryRun = args.dryRun ?? true;
  const name = opportunityName(args.year, args.month);
  const dateISO = lastDayOfMonthISO(args.year, args.month);
  const monetaryValue = Math.round(args.monetaryValue * 100) / 100;
  const existing = await findMonthlyOpportunity(args.year, args.month, client);
  const customFields = [{ id: CAFE_FUEL.dateFieldId, field_value: dateISO }];

  if (existing) {
    const payload: Record<string, unknown> = {
      name,
      pipelineStageId: CAFE_FUEL.stageId,
      status: CAFE_FUEL.status,
      monetaryValue,
      customFields,
    };
    if (!dryRun) {
      await client.request({ method: 'PUT', path: `/opportunities/${existing.id}`, body: payload, autoLocation: false });
    }
    return { action: 'update', id: existing.id, name, monetaryValue, dateISO, payload, dryRun };
  }

  const payload: Record<string, unknown> = {
    pipelineId: CAFE_FUEL.pipelineId,
    locationId: client.locationId,
    name,
    pipelineStageId: CAFE_FUEL.stageId,
    status: CAFE_FUEL.status,
    contactId: CAFE_FUEL.contactId,
    monetaryValue,
    customFields,
  };
  let id: string | undefined;
  if (!dryRun) {
    const res = await client.request<any>({ method: 'POST', path: '/opportunities/', body: payload, autoLocation: false });
    id = res.opportunity?.id ?? res.id;
  }
  return { action: 'create', id, name, monetaryValue, dateISO, payload, dryRun };
}

export interface VerifyResult {
  ok: boolean;
  expectedEpochMs: number;
  actualEpochMs: number | null;
  expectedValue: number;
  actualValue: number | null;
  message: string;
}

/** Read the opportunity back via the search endpoint and assert value + date landed. */
export async function verifyMonthlyOpportunity(
  year: number, month: number, expectedValue: number, client: GhlClient = ghl(),
): Promise<VerifyResult> {
  const opp = await findMonthlyOpportunity(year, month, client);
  const expectedEpochMs = lastDayEpochMs(year, month);
  const expectedVal = Math.round(expectedValue * 100) / 100;
  const actualEpochMs = opp?.dateEpochMs ?? null;
  const actualValue = opp?.monetaryValue ?? null;
  const dateOk = actualEpochMs === expectedEpochMs;
  const valOk = actualValue != null && Math.abs(actualValue - expectedVal) < 0.005;
  const ok = !!opp && dateOk && valOk;
  return {
    ok, expectedEpochMs, actualEpochMs, expectedValue: expectedVal, actualValue,
    message: !opp ? 'opportunity not found on read-back'
      : ok ? 'verified: value + reporting-month date match'
      : `mismatch — date ${dateOk ? 'ok' : `expected ${expectedEpochMs} got ${actualEpochMs}`}; value ${valOk ? 'ok' : `expected ${expectedVal} got ${actualValue}`}`,
  };
}
