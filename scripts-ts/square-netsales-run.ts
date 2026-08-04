// scripts-ts/square-netsales-run.ts — pull Square Net Sales for a month and
// create/update the Cafe Fuel monthly opportunity in GHL. Mirrors reconcile-run.ts.
//
//   npx vite-node scripts-ts/square-netsales-run.ts                      # DRY-RUN, most recent completed month
//   npx vite-node scripts-ts/square-netsales-run.ts --month 2026-07      # DRY-RUN, a specific month
//   npx vite-node scripts-ts/square-netsales-run.ts --apply --yes        # APPLY (writes to GHL) — needs --yes
//   npx vite-node scripts-ts/square-netsales-run.ts --month 2026-07 --apply --yes
//
// Flags: --month YYYY-MM (default: last completed month) --apply (default dry-run) --yes (confirm writes)
//        --timestamp closed_at|created_at (default closed_at) --tz America/Detroit --force (allow unfinished month)
// Reads Square + GHL creds from .env.local. Target GHL via GHL_TARGET=live|sandbox (default live).
// Always prints the full Net Sales breakdown so you can calibrate against the Square Dashboard.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMonthlyNetSales, parseMonthArg, previousMonth, monthRange, TimestampField } from '../lib/square/netSales';
import { getSquareConfig } from '../lib/square/config';
import { upsertMonthlyOpportunity, verifyMonthlyOpportunity } from '../lib/ghl/opportunities';
import { ghl } from '../lib/ghl/client';

function loadEnvLocal() {
  try {
    const txt = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* ok */ }
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);
const money = (n: number, c = 'USD') => `${c === 'USD' ? '$' : c + ' '}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  loadEnvLocal();
  const cfg = getSquareConfig();
  const tz = arg('tz') || cfg.timezone;
  const apply = has('apply');
  const yes = has('yes');
  const force = has('force');
  const timestampField = (arg('timestamp') as TimestampField) || 'closed_at';

  const monthArg = arg('month');
  const { year, month } = monthArg ? parseMonthArg(monthArg) : previousMonth(tz);
  const range = monthRange(year, month, tz);

  if (!force && new Date(range.endAt).getTime() > Date.now()) {
    console.error(`Refusing to run: ${range.label} is not finished yet (ends ${range.endAt}). Use --force to override.`);
    process.exit(2);
  }
  if (apply && !yes) {
    console.error('Refusing to write without --yes. Add --yes to confirm GHL writes (or drop --apply for a dry-run).');
    process.exit(2);
  }

  console.log(`\n=== Square Net Sales -> GHL :: ${range.label} ===`);
  console.log(`timezone=${tz}  bucket=${timestampField}  window=[${range.startAt}, ${range.endAt})  mode=${apply ? 'APPLY' : 'DRY-RUN'}`);

  const { summary } = await getMonthlyNetSales(year, month, { timezone: tz, timestampField });
  const c = summary.currency;
  console.log(`\nOrders (COMPLETED): ${summary.orderCount}`);
  console.log(`  Gross sales        ${money(summary.grossSales, c)}`);
  console.log(`  - Discounts/comps  ${money(summary.discounts, c)}`);
  console.log(`  ----------------------------`);
  console.log(`  NET SALES          ${money(summary.netSales, c)}   <- opportunity value`);
  console.log(`  (line-item check)  ${money(summary.lineItemNetSalesCheck, c)}`);
  console.log(`  memo: tax ${money(summary.tax, c)} · tips ${money(summary.tips, c)} · svc ${money(summary.serviceCharges, c)} · total collected ${money(summary.totalCollected, c)}`);

  const client = ghl();
  const upsert = await upsertMonthlyOpportunity({ year, month, monetaryValue: summary.netSales, dryRun: !apply, client });
  console.log(`\nGHL opportunity: ${apply ? upsert.action.toUpperCase() : 'would ' + upsert.action}${upsert.id ? ` (id ${upsert.id})` : ''} -> "${upsert.name}"  value ${money(upsert.monetaryValue, c)}  date ${upsert.dateISO}`);

  if (!apply) {
    console.log('DRY-RUN — no GHL writes made. Re-run with --apply --yes to write.');
    console.log('payload:', JSON.stringify(upsert.payload));
    return;
  }
  const v = await verifyMonthlyOpportunity(year, month, summary.netSales, client);
  console.log(`verify: ${v.ok ? 'OK' : 'FAILED'} — ${v.message}`);
  if (!v.ok) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
