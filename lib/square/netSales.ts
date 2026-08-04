// lib/square/netSales.ts — pull Square orders for a month and compute "Net Sales".
//
// Square has NO direct "net sales" report endpoint, so we aggregate the Orders API
// (POST /v2/orders/search), matching Square's Sales Summary definition:
//
//     Net Sales = Gross Sales − Returns − Discounts & Comps      (excludes tax & tips)
//
// Each COMPLETED order carries `net_amounts` = "sale money − return money" (i.e. already
// net of returns). So per order:
//     netSales = net_amounts.total_money − tax_money − tip_money − service_charge_money
// Summed over the month this equals gross − discounts − returns, before tax/tips.
//
// Money is integer cents; we keep cents internally and expose dollars on the summary.

import { SquareClient, square } from './client';

// ---- Money helpers -------------------------------------------------------
interface Money { amount?: number; currency?: string }
const cents = (m?: Money): number => (m && typeof m.amount === 'number' ? m.amount : 0);

// ---- Time / month helpers (timezone-aware, dependency-free) --------------
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const pad = (n: number) => String(n).padStart(2, '0');

/** Offset (ms) of `date` in `timeZone`, i.e. localWallClock - UTC. */
function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === '24' ? '0' : p.hour), +p.minute, +p.second);
  return asUTC - date.getTime();
}

/** The UTC instant of a wall-clock time in `timeZone`. */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - off);
}

export interface MonthRange {
  year: number;
  month: number;        // 1-12
  label: string;        // "January 2026"
  startAt: string;      // RFC3339 UTC, inclusive
  endAt: string;        // RFC3339 UTC, exclusive (next month start)
  lastDayISO: string;   // "2026-01-31"
  lastDayEpochMs: number; // midnight UTC of the last day (GHL date-field convention)
}

export function monthRange(year: number, month: number, tz: string): MonthRange {
  const start = zonedToUtc(year, month, 1, 0, 0, 0, tz);
  const ny = month === 12 ? year + 1 : year;
  const nm = month === 12 ? 1 : month + 1;
  const end = zonedToUtc(ny, nm, 1, 0, 0, 0, tz);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    year, month,
    label: `${MONTHS[month - 1]} ${year}`,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    lastDayISO: `${year}-${pad(month)}-${pad(lastDay)}`,
    lastDayEpochMs: Date.UTC(year, month - 1, lastDay),
  };
}

/** Parse "YYYY-MM" → {year, month}. */
export function parseMonthArg(s: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Bad --month "${s}". Use YYYY-MM, e.g. 2026-07.`);
  const year = +m[1], month = +m[2];
  if (month < 1 || month > 12) throw new Error(`Bad month in "${s}".`);
  return { year, month };
}

/** The most recent fully-completed month, in the given timezone. */
export function previousMonth(tz: string, now: Date = new Date()): { year: number; month: number } {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(now)) p[part.type] = part.value;
  let year = +p.year, month = +p.month - 1;
  if (month < 1) { month = 12; year -= 1; }
  return { year, month };
}

// ---- Order fetch + aggregation -------------------------------------------
export type TimestampField = 'closed_at' | 'created_at';

export async function searchOrders(
  client: SquareClient,
  locationId: string,
  range: MonthRange,
  timestampField: TimestampField = 'closed_at',
): Promise<any[]> {
  const orders: any[] = [];
  let cursor: string | undefined;
  do {
    const body: any = {
      location_ids: [locationId],
      limit: 500,
      query: {
        filter: {
          state_filter: { states: ['COMPLETED'] },
          date_time_filter: { [timestampField]: { start_at: range.startAt, end_at: range.endAt } },
        },
        sort: { sort_field: timestampField.toUpperCase(), sort_order: 'ASC' },
      },
    };
    if (cursor) body.cursor = cursor;
    const res = await client.request<any>({ method: 'POST', path: '/v2/orders/search', body });
    for (const o of res.orders ?? []) orders.push(o);
    cursor = res.cursor;
  } while (cursor);
  return orders;
}

export interface NetSalesSummary {
  label: string;
  currency: string;
  orderCount: number;
  // dollars, rounded to cents
  netSales: number;
  grossSales: number;
  discounts: number;
  tax: number;
  tips: number;
  serviceCharges: number;
  totalCollected: number;
  // cross-check via line items (should ≈ grossSales − discounts, ignoring returns)
  lineItemNetSalesCheck: number;
}

/** Compute the Net Sales summary from a list of COMPLETED orders. */
export function computeNetSales(orders: any[], label: string): NetSalesSummary {
  let netC = 0, grossC = 0, discC = 0, taxC = 0, tipC = 0, svcC = 0, totalC = 0, liNetC = 0;
  let currency = 'USD';
  for (const o of orders) {
    const na = o.net_amounts ?? {};
    if (na.total_money?.currency) currency = na.total_money.currency;
    const total = cents(na.total_money);
    const tax = cents(na.tax_money);
    const tip = cents(na.tip_money);
    const svc = cents(na.service_charge_money);
    const disc = cents(na.discount_money);
    // Net Sales (Square def): total (net of returns) minus tax, tips, service charges.
    netC += total - tax - tip - svc;
    taxC += tax; tipC += tip; svcC += svc; discC += disc; totalC += total;
    // Gross sales = net sales + discounts (returns already reflected in net_amounts).
    // Line-item cross check (ignores returns): Σ gross_sales_money − Σ line total_discount_money.
    for (const li of o.line_items ?? []) {
      liNetC += cents(li.gross_sales_money) - cents(li.total_discount_money);
    }
  }
  grossC = netC + discC;
  const d = (c: number) => Math.round(c) / 100;
  return {
    label, currency, orderCount: orders.length,
    netSales: d(netC), grossSales: d(grossC), discounts: d(discC),
    tax: d(taxC), tips: d(tipC), serviceCharges: d(svcC), totalCollected: d(totalC),
    lineItemNetSalesCheck: d(liNetC),
  };
}

/** One-call convenience: fetch a month's orders and compute the summary. */
export async function getMonthlyNetSales(
  year: number,
  month: number,
  opts: { client?: SquareClient; timezone?: string; timestampField?: TimestampField } = {},
): Promise<{ range: MonthRange; summary: NetSalesSummary; orders: any[] }> {
  const client = opts.client ?? square();
  const tz = opts.timezone ?? client.config.timezone;
  const range = monthRange(year, month, tz);
  const orders = await searchOrders(client, client.locationId, range, opts.timestampField ?? 'closed_at');
  const summary = computeNetSales(orders, range.label);
  return { range, summary, orders };
}
