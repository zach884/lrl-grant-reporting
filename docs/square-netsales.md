# Square Net Sales → GHL (Cafe Fuel scorecard)

Pulls **Net Sales** for Cafe Fuel from Square each month and writes it into the
**Cafe Fuel Sales** pipeline in GHL as a monthly opportunity, so it shows on the
scorecard dashboard report.

## What it does

For a given month it:

1. Fetches all `COMPLETED` Square orders for the Cafe Fuel location in that month
   (bucketed by `closed_at`, in `America/Detroit`).
2. Computes **Net Sales** = Gross Sales − Returns − Discounts & Comps (excludes tax
   and tips) — Square's Sales Summary definition, via each order's `net_amounts`.
3. Creates or updates the opportunity **"Cafe Fuel | <Month> <Year> Sales"** with:
   - `monetaryValue` = Net Sales
   - custom field **Cafe Fuel Reporting Month** = last calendar day of the month
   - pipeline **Cafe Fuel Sales**, stage **Monthly Sales**, status `won`,
     contact **Faith Seneff / Cafe Fuel**.
   It is **idempotent**: it matches an existing month (by the reporting-month date,
   then by name) and updates it in place rather than making duplicates.
4. Reads the opportunity back and verifies the value + date landed.

## One-time setup: Square access token

You have a Square login but have never used the developer console. Steps:

1. Go to <https://developer.squareup.com/apps> and sign in with your Square login.
2. Click **+ Create your first application** (name it e.g. `LRL Reporting`). Accept
   the developer terms.
3. Open the app → left nav **Credentials** → toggle **Production** at the top.
4. Under **Production Access token**, click **Show** and copy the token. This is a
   personal token with read access to your own account (we only read orders).
5. Get the **Location ID** for Cafe Fuel: left nav **Locations** (or the
   **Locations** section of Credentials) → copy the ID for the Cafe Fuel location.

Then add these to `.env.local` (already scaffolded there as commented placeholders):

```
SQUARE_ACCESS_TOKEN=EAAA...your-production-token...
SQUARE_LOCATION_ID=LXXXXXXXXXXXX
# optional:
# SQUARE_ENV=production          # or sandbox
# SQUARE_TIMEZONE=America/Detroit
# SQUARE_VERSION=                # leave blank to use the token's default API version
```

> The token is a secret — it stays in `.env.local` (git-ignored). Don't commit it.

## Usage

```bash
# DRY-RUN the most recent completed month (no writes; prints the breakdown + payload)
npm run square:netsales

# DRY-RUN a specific month
npm run square:netsales -- --month 2026-07

# APPLY (write to GHL) — requires --yes
npm run square:netsales -- --month 2026-07 --apply --yes
```

Flags: `--month YYYY-MM` (default: last completed month) · `--apply` (default is
dry-run) · `--yes` (confirm writes) · `--timestamp closed_at|created_at` · `--tz`
· `--force` (allow a month that isn't over yet).

## Calibrate once against the Square Dashboard

Square has no direct "net sales" endpoint, so this aggregates orders. Small
differences from the dashboard can come from timezone or which timestamp buckets an
order. **Before trusting it, run one dry-run for a month you already know** and
compare `NET SALES` to Square Dashboard → Reports → Sales Summary for the same month:

```bash
npm run square:netsales -- --month 2026-07
```

If it's off, try `--timestamp created_at`, and confirm `--tz America/Detroit`. The
`(line-item check)` line is an independent cross-check of the figure. Once a known
month matches, you're calibrated.

## Scheduling (monthly)

Run on the 1st for the prior month. Options, cheapest first:

- **External cron / GitHub Action** (same place the nightly sync reconcile will run;
  see `DEPLOY_SYNC.md`): `npm run square:netsales -- --apply --yes` on `0 6 1 * *`.
- **Local cron/launchd** on the LRL machine if the app isn't deployed yet.

With no `--month`, it targets the most recent completed month automatically, so the
1st-of-month schedule needs no date argument.

## Files

- `lib/square/` — Square client + Net Sales aggregation (`config.ts`, `client.ts`, `netSales.ts`)
- `lib/ghl/opportunities.ts` — Cafe Fuel opportunity create/update/verify
- `scripts-ts/square-netsales-run.ts` — the runner (`npm run square:netsales`)
