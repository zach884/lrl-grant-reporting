// lib/ghl/opportunities.ts — create/update the monthly Cafe Fuel sales opportunity.
//
// Verified live 2026-08-04 against the Cafe Fuel Sales pipeline:
// - POST /opportunities/ create (locationId required in body)
// - PUT /opportunities/{id} partial update (preserves contact/pipeline/stage)
// - DATE custom field writes as customFields:[{ id, field_value:"YYYY-MM-DD" }]
//   (the epoch-number form is rejected 400). Stored as midnight-UTC epoch.
// - search endpoint returns the date as fieldValueDate (epoch ms); single GET as
//   fieldValue ("YYYY-MM-DD"). Both shapes are handled below.
//
// READ-BACK CONSISTENCY (fixed 2026-09-01)
// GET /opportunities/search is Elasticsearch-backed and eventually consistent. Verifying
// through it immediately after a create returns nothing for a second or two, which made the
// 1 Sep 2026 run post the correct August figure and then exit 1 with
// "opportunity not found on read-back". GET /opportunities/{id} is strongly consistent, so
// verification now prefers it whenever the upsert handed back an id, and only falls back to
// the search index (with retries) when there is no id to read.

import { GhlClient, ghl } from './client';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  /** From the search endpoint (fieldValueDate). Null when only the ISO form came back. */
  dateEpochMs: number | null;
  /** From the single-GET endpoint (fieldValue). Null when only the epoch form came back. */
  dateISO: string | null;
}

/**
 * Normalise one opportunity payload. The reporting-month date field arrives as an epoch
 * number from /opportunities/search and as a "YYYY-MM-DD" string from /opportunities/{id},
 * so keep whichever we were given rather than guessing a conversion.
 */
function mapOpp(o: any): MonthlyOpp {
  let epoch: number | null = null;
  let iso: string | null = null;
  for (const cf of o.customFields ?? []) {
    if (cf.id !== CAFE_FUEL.dateFieldId) continue;
    if (typeof cf.fieldValueDate === 'number') epoch = cf.fieldValueDate;
    if (typeof cf.fieldValue === 'string' && cf.fieldValue) iso = cf.fieldValue;
  }
  return { id: o.id, name: o.name, monetaryValue: o.monetaryValue, dateEpochMs: epoch, dateISO: iso };
}

/** Read all opportunities in the Cafe Fuel pipeline (small; single page suffices). */
export async function listCafeFuelOpps(client: GhlClient = ghl()): Promise<MonthlyOpp[]> {
  const res = await client.request<any>({
    path: '/opportunities/search',
    params: { location_id: client.locationId, pipeline_id: CAFE_FUEL.pipelineId, limit: 100 },
    autoLocation: false,
  });
  return (res.opportunities ?? []).map(mapOpp);
}

/**
 * Read one opportunity by id. Strongly consistent, unlike the search index, so this is the
 * right call for verifying a write that just happened. Returns null on 404.
 */
export async function getOpportunityById(
  id: string, client: GhlClient = ghl(),
): Promise<MonthlyOpp | null> {
  try {
    const res = await client.request<any>({
      path: `/opportunities/${id}`,
      autoLocation: false,
    });
    const opp = res.opportunity ?? res;
    return opp && opp.id ? mapOpp(opp) : null;
  } catch (err: any) {
    if (err && err.status === 404) return null;
    throw err;
  }
}

/** Find the opportunity for a month — match on the reporting-month date first, name second. */
export async function findMonthlyOpportunity(
  year: number, month: number, client: GhlClient = ghl(),
): Promise<MonthlyOpp | null> {
  const opps = await listCafeFuelOpps(client);
  const targetEpoch = lastDayEpochMs(year, month);
  const targetISO = lastDayOfMonthISO(year, month);
  const targetName = opportunityName(year, month).toLowerCase();
  return (
    opps.find((o) => o.dateEpochMs === targetEpoch) ??
    opps.find((o) => o.dateISO === targetISO) ??
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
  expectedISO: string;
  actualISO: string | null;
  expectedValue: number;
  actualValue: number | null;
  /** How the record was read back: "GET /opportunities/{id}" or "search". */
  via: string;
  attempts: number;
  message: string;
}

export interface VerifyOptions {
  /** Id returned by the upsert. When present, verification reads the record directly. */
  id?: string;
  /** Read-back attempts before giving up (default 5). */
  attempts?: number;
  /** Delay between attempts, ms (default 2000). */
  delayMs?: number;
}

/**
 * Read the opportunity back and assert value + reporting-month date landed.
 *
 * Prefers GET /opportunities/{id} (strongly consistent) when an id is available. Falls back
 * to the search index, retrying, because that index lags a write by a second or more and a
 * bare single read produced a false "not found" on 2026-09-01.
 */
export async function verifyMonthlyOpportunity(
  year: number,
  month: number,
  expectedValue: number,
  client: GhlClient = ghl(),
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const maxAttempts = Math.max(1, opts.attempts ?? 5);
  const delayMs = opts.delayMs ?? 2000;

  let opp: MonthlyOpp | null = null;
  let via = 'search';
  let attempts = 0;

  for (let i = 1; i <= maxAttempts; i++) {
    attempts = i;
    if (opts.id) {
      opp = await getOpportunityById(opts.id, client);
      via = `GET /opportunities/${opts.id}`;
    }
    if (!opp) {
      opp = await findMonthlyOpportunity(year, month, client);
      via = opts.id ? `search (after GET ${opts.id} missed)` : 'search';
    }
    if (opp) break;
    if (i < maxAttempts) await sleep(delayMs);
  }

  const expectedEpochMs = lastDayEpochMs(year, month);
  const expectedISO = lastDayOfMonthISO(year, month);
  const expectedVal = Math.round(expectedValue * 100) / 100;
  const actualEpochMs = opp?.dateEpochMs ?? null;
  const actualISO = opp?.dateISO ?? null;
  const actualValue = opp?.monetaryValue ?? null;

  // Compare whichever representation the endpoint gave us. Requiring both would fail
  // every time, since neither endpoint returns both shapes.
  const dateOk =
    actualISO != null ? actualISO === expectedISO
    : actualEpochMs != null ? actualEpochMs === expectedEpochMs
    : false;
  const valOk = actualValue != null && Math.abs(actualValue - expectedVal) < 0.005;
  const ok = !!opp && dateOk && valOk;

  const dateDetail = dateOk
    ? 'ok'
    : actualISO != null ? `expected ${expectedISO} got ${actualISO}`
    : `expected ${expectedEpochMs} got ${actualEpochMs}`;

  return {
    ok,
    expectedEpochMs, actualEpochMs,
    expectedISO, actualISO,
    expectedValue: expectedVal, actualValue,
    via, attempts,
    message: !opp
      ? `opportunity not found on read-back via ${via} after ${attempts} attempt(s)`
      : ok ? `verified via ${via}: value + reporting-month date match`
      : `mismatch via ${via} — date ${dateDetail}; value ${valOk ? 'ok' : `expected ${expectedVal} got ${actualValue}`}`,
  };
}
