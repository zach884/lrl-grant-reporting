# Plan — Change Log / Activity (audit history of every change the app makes)

> Status: SPEC (Zach, 2026-08-03). Chosen: full-value ("PII") version — log the actual before→after
> values (essential for debugging + funder audit). Volume is managed separately (below), not by dropping
> values. Lands in the existing "Activity Reporting" nav slot.

## Goal
A durable, queryable, exportable record of **every change our app makes to a connected system** (GHL,
Wix): which record changed, which field(s) (before → after), which sync/enricher/scorer did it, *why*
(provenance/rationale), when, what triggered it, and whether it was applied vs a dry-run. Answers
"who changed this field and why" as a query instead of a spelunk (e.g. the whole Khloe/Litty Fit
investigation would have been one screen), and gives funders an audit trail.

The data already exists at every write — enrichers return provenance (`source/method/confidence/
rationale`), syncs return field diffs (`{fieldKey, from, to}`), the scorer returns scores + rationale.
This just persists + surfaces it.

## Storage — append-only Postgres table `change_log`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| ts | timestamptz | when the write happened |
| app | text | 'ghl' \| 'wix' |
| object_type | text | 'contact' \| 'business' \| 'custom_objects.business_stage' \| 'wix:<collection>' |
| record_id | text | target record id |
| record_label | text | best-effort human name (company/contact name) |
| actor_kind | text | 'sync' \| 'enricher' \| 'scorer' |
| actor_name | text | 'contact-to-company', 'company-to-contacts', 'naics', 'county', 'geo-zone', 'client-stage-scorer', 'readiness-tagger', 'wix:team' |
| action | text | 'create' \| 'update' |
| changes | jsonb | `[{ field, from, to }]` — one row per record-change (field-diffs as an array; chosen over one-row-per-field for volume) |
| method | text | 'ai' \| 'api' \| 'computed' \| 'sync' \| 'staff' |
| confidence | real (nullable) | enricher confidence |
| rationale | text (nullable) | enricher/scorer reasoning |
| trigger | text | 'webhook:contact-changed' \| 'batch:<script>' \| 'manual' |
| run_id | text | correlation id — one webhook/batch invocation ⇒ see the whole fan-out |
| applied | boolean | true = written; false = dry-run |
| error | text (nullable) | populated when the write failed |

Indexes: `(record_id, ts desc)`, `(actor_name, ts desc)`, `(run_id)`, `(ts desc)`.

## Sink — `lib/audit/log.ts`
`logChange(event)` / `logChanges(events[])` — **best-effort**: wrapped in try/catch, no-ops without a DB,
NEVER throws into a sync/enrich path (same discipline as `stateStore`). Batches a run's events.

## Instrumentation points (thread the diffs/provenance already computed)
- **Sync engine** (`lib/sync/apply.ts`): after each forward/reverse apply, emit one event per target
  record from `ApplyChange[] {fieldKey, from, to}` + the connection slug as `actor_name`.
- **Company enrichers** (`lib/enrichment/engine.ts` `enrichCompany`): emit from `result.applied`
  (`businessKey`, value, provenance → method/confidence/rationale).
- **Contact / record enrichers** (`contactEngine` / `recordEngine`): same.
- **Scorer** (`lib/stage/trigger.ts`): emit the stage record create/update with scores + rationale.
- **Wix sync** (`lib/wix-sync/*`): emit per Wix row upsert.
- **Webhook** (`/api/sync/up`) mints a `run_id` and threads it so all fan-out writes correlate; batch
  scripts pass `trigger: 'batch:<name>'`.

## UI — `pages/activity.tsx` (the "Activity Reporting" nav slot) + `pages/api/activity/list.ts`
- Filterable list: by record id, app, actor (sync/enricher/scorer), date range, applied/dry-run.
- **Per-record timeline** ("everything that happened to this company/contact"), newest first.
- Expandable field-diffs (`from → to`) + rationale + confidence badge.
- **CSV export** (the funder-audit artifact).
- Paginated, filtered read API.

## Volume — managed without sacrificing detail
- Log **applied** changes only by default (skip equality-guard no-ops); dry-runs optional behind a flag.
- One row **per record-change** (field-diffs as JSON) rather than per field.
- **Retention** window (e.g. prune/export > 18 months) via a scheduled job.

## Considerations
- **Best-effort/non-fatal** — logging failure must never break a write.
- **PII** — stores field values (incl. personal data); mitigate with app-auth access control + retention
  (same data already lives in GHL). This is the accepted trade for debuggability/audit.
- **Correlation** — `run_id` per invocation to trace one Contact-Changed event across GHL + Wix.

## Phasing
1. **Phase 1 (bulk of the value):** table + `logChange` sink + instrument the write paths + `run_id`
   threading. No UI yet — verify via DB queries. Debugging/audit data starts accumulating immediately.
2. **Phase 2:** the Activity page + list API + per-record timeline + filters + CSV export.
3. **Phase 3 (optional):** retention job, error alerting, "changes since last funder report" export.

## Effort
Moderate–large (cross-cutting instrumentation + a UI). Phase 1 delivers most of the debugging/audit value.
