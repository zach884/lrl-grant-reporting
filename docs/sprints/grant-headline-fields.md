# Brief — close the grant headline fields (0/63 → populated)

> **Written 2026-09-02** with Zach, from live measurement. Small, self-contained, no new GHL webhook.
> Unblocks **TC col R/S/T** (Direct Grant, Date Awarded, Reason) and **SBSH Total Dollars Deployed**,
> and is a prerequisite for attributing a grant to the TC vs SBSH budget.
> Parent sprint: `sprint-c-tc-report.md`.

## The problem, precisely

63 `grant` activities exist and are correctly keyed. Four fields on them are **empty on all 63**:

| Activity field | Type |
|---|---|
| `award_amount` | NUMERICAL |
| `award_date` | DATE |
| `grant_program` | SINGLE_OPTIONS |
| `grant_reason` | LARGE_TEXT |

**Why — measured, not guessed.** Two independent causes, and neither is a missing field:

**1. The form adapter's map is derived by KEY MATCH.** Per `sources/form.ts`, ~90% of grant activity
fields share their contact field's key, so the map is derived rather than hand-authored. These four
have **no contact field with a matching key**, so they are silently never copied:

| Activity field | Contact field that actually holds it | Match? |
|---|---|---|
| `grant_program` | `contact.direct_grant_program` | ❌ different key |
| `grant_reason` | `contact.please_do_into_detail_on_how_you_will_specifically_utilize_the_funds_if_awarded_a_direct_grant` | ❌ different key |
| `award_amount` | **not on the contact at all** — it is `opportunity.monetaryValue` | ❌ wrong object |
| `award_date` | **exists nowhere** — it is a stage-change moment | ❌ must be derived |

(`score_total_grant_amount` DOES key-match and already copies — verified in a live dry run.)

**2. Nothing triggers the form copy at the reportable moment.** `sources/opportunityStage.ts` writes
only `activity_date`, `activity_name`, `program__grant_association`, `activity_notes` and
`route.defaults`. `route.defaults` writes **static** values, so it structurally cannot carry a
per-contact amount. The stage webhook arrives; the field copy never runs.

## What Zach settled

- **The Direct Grants pipeline completes at `Closed Won`, after `Receipts Received`.** That is the
  point at which the process is done and nothing further changes.
- **No new GHL webhook.** The existing "Opportunity Stage Changed" workflow already delivers stage
  changes for all three pipelines (LOCAL Bootcamp, SAMA Cohort, Direct Grants), and all four Direct
  Grant stages are already routed to `grant` and enabled. This is app-side only.

## The build

**1. An explicit alias map for the key mismatches.** Extend the derived map in `sources/form.ts` with
a small, declared alias table for the fields whose keys differ. Keep it declared and few — the derived
map is the rule, aliases are the documented exceptions. Log them, so a future field rename is loud.

**2. `award_amount` ← `opportunity.monetaryValue`.** Measured live: `4000` and `3999.98` on two `won`
Direct Grants opportunities. There is a published GHL workflow "Copy Grant Value to Opportunity for
Updated Approved Grants", so the opportunity is the intended home for the approved amount. Read it in
the opportunity adapter, which already has the opportunity in hand.

**3. `award_date` ← `lastStageChangeAt` captured at `Direct Grant · Agreement Executed`, `onlyIfAbsent`.**
It is the funder's "Date Direct Grant Awarded" (TC col S), so it must be the award moment, **not** the
Closed Won moment and not the sweep's run date. `onlyIfAbsent` is what stops a later stage moving it.

**4. Run the form field-copy from the opportunity path at the reportable stages.** Gate it on a route
flag (e.g. `copyFormFields: '0d8irJ6Ay6VQFajG06Go'`) rather than hardcoding, so it stays config. The
two adapters **already converge**: a live dry run of the form path keyed
`Opportunity Stage/<oppId>:grant` — the exact key the opportunity adapter uses — and reported
`would-update`, not `would-create`. So this merges into the existing record and cannot duplicate.

Fire at **Agreement Executed** (line items final → the amount and reason are real) and again at
**Closed Won** (process complete). Copying twice is safe because the path is idempotent and
equality-guarded; the second pass is a `noop` unless something genuinely changed.

## 🔴 Two traps, both silent

**1. `activity_date` MUST stay guarded.** A live dry run of the form path reported it would write
`activity_date`. `opportunityStage.ts` deliberately guards it for grants —
`onlyIfAbsent: ['activity_date']` — and its comment records the measurement: before the nightly sweep
was scheduled, **one sweep would have rewritten `activity_date` on all 50 grant activities** to
whenever the sweep ran, replacing the real award dates in TC col S. **The form copy must inherit the
same guard when invoked from the stage path.** Add a test that asserts it.

**2. `grant_reason` is now the applicant's own words, not the AI summary.** The old GHL workflow ran a
ChatGPT step over the contact's line items and fired while they were still blank, so the stored value
is the model apologising for having nothing to read. Sourcing col T from
`please_do_into_detail_on_how_you_will_specifically_utilize_the_funds…` is **more defensible to a
funder** than an AI paraphrase — but it is a change in meaning, so state it in the output.
`isAiFailureText` already exists; keep rejecting the apology shape on read.

## Backfill

All 63 records can be filled immediately — no waiting on new submissions:
- `award_amount` from each opportunity's `monetaryValue`
- `grant_program` / `grant_reason` from the contact via the alias map
- `award_date` only where an Agreement Executed timestamp can be recovered; otherwise **leave empty
  and report it** rather than substituting a plausible wrong date. An empty col S is a declared gap;
  a wrong award date is a compliance problem.

Dry-run → review → apply, per CLAUDE.md.

## Acceptance

1. `award_amount` populated on every grant activity whose opportunity carries a `monetaryValue`.
2. `grant_program` and `grant_reason` populated wherever the contact holds them; the alias map is
   declared in one place and logged.
3. `award_date` set from Agreement Executed, and **provably not moved** by a later stage or a sweep —
   with a test.
4. A re-run reports `noop`, not a rewrite.
5. `grant_status` continues to track the pipeline stage.
6. Census re-run shows the 0/63 closed, with any remaining gap catalogued and explained.
