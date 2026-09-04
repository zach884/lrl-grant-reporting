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

---

## Verification against live, 2026-09-03 — before building

The brief's diagnosis is confirmed exactly: all four headline fields exist on the activities object,
**none** has a key-matching contact field (so the derived map can never reach them), and both contact
fields named as the real homes exist with compatible types. `score_total_grant_amount` does
key-match and is 59/64 populated, as predicted. Now **64** grant activities, not 63.

```
0/64  award_amount        0/64  grant_program          62/64  grant_status
0/64  award_date          0/64  grant_reason           64/64  activity_date
0/64  program__grant_association    <-- the brief expected opportunityStage to write this
```

### What is actually recoverable

| Target | Source | Recoverable |
|---|---|---|
| `award_amount` | `opportunity.monetaryValue` | **64/64** — total $347,311.63, range $825–$22,000 |
| `grant_program` | `contact.direct_grant_program` | **58/64** (46 SBSH · 12 Trusted Connector · 6 empty) |
| `grant_reason` | `contact.please_do_into_detail…` | **17/64** 🔴 — the brief assumed this field was the home; it is, but only 17 contacts hold it |
| `award_date` | Execute Agreement moment | **0/64 by the brief's rule** — see below |

Zero of the 64 reason texts are the ChatGPT apology, so `isAiFailureText` finds nothing to reject
here — that failure lived on the spreadsheet, not on this field.

### 🔴 The stage is called **Execute Agreement**, and nothing sits at it

Live stage list for Direct Grants (`trGMRtrlkvUG1UtMbuMJ`): Prospect → Schedule Direct Grant Meeting
→ Complete Direct Grant Application → **Execute Agreement** (`0dfd181d…`) → **Receive Receipts**
(`29569048…`) → **Closed Won** (`37c0eae6…`) → Closed Lost.

Current distribution: **36 Closed Won · 26 Receive Receipts · 2 Closed Lost — and 0 at Execute
Agreement.** GHL exposes **no stage history**: an opportunity carries only `pipelineStageId` and
`lastStageChangeAt`. So what that timestamp *means* depends entirely on where the record sits now:

- **26 at Receive Receipts** — `lastStageChangeAt` is the moment it LEFT Execute Agreement, which is
  within days of the award. **Defensible as `award_date`.**
- **36 at Closed Won + 2 lost** — `lastStageChangeAt` is when receipts were accepted, potentially
  weeks after the award. **Not an award date.** Per the brief: leave empty and report it. An empty
  col S is a declared gap; a wrong award date is a compliance problem.

Capturing it correctly **going forward** works as the brief describes — fire at Execute Agreement and
stamp it `onlyIfAbsent`. It is only the backfill that is limited, and to 26 of 64.

### 🔴🔴 A live data bug this surfaced: `activity_date` is the ingest date on 52 of 64

`activity_date` is 100% populated — but it is **2026-08-20 on 52 records**, the day the first grant
backfill ran, while `lastStageChangeAt` on those same records holds real, well-spread dates
(2025-11-25 → 2026-09-02, across 47 distinct days).

```
activity_date == lastStageChangeAt : 12
activity_date differs              : 52     e.g. activity_date 2026-08-20 / real stage change 2026-01-31
```

This is the drift the `onlyIfAbsent: ['activity_date']` guard was added to stop — but the guard went
in *after* the first backfill had already written the run date, so it **froze the wrong value in
place** rather than preventing it. The guard is working exactly as designed and is now protecting an
artifact.

**Why it matters more than an empty column:** `activity_date` is what puts an activity in a reporting
period. A grant awarded 2026-01-31 but dated 2026-08-20 is counted in the wrong half-year on every
report that filters by period — and it looks completely plausible, because the field is populated.

**Proposed repair,** as its own reviewed change: set `activity_date` from `lastStageChangeAt` where
the two disagree and the opportunity's stage makes the timestamp meaningful, and report the remainder.
This must NOT be folded into the field backfill — it rewrites a guarded field on 52 live records and
deserves its own dry run and its own approval.

### BAF — latent today, but Zach's answer widens Gateway

The picklist mismatch is real (`contact.direct_grant_program` offers BAF; `activities.grant_program`
does not) but **no backfill is blocked by it: 0 of 64 contacts say BAF.** Only one opportunity NAME
mentions it — "Direct Grant – Blue Entity - Discretionary BAF" — and that contact is recorded as
Trusted Connector.

No picklist rewrite is needed. Zach, 2026-09-03: *"BAF is Gateway. BAF is a funding type for grants
but it's under the umbrella of Gateway. Every company who gets BAF is eligible for Gateway
reporting."* `activities.grant_program` already offers **Gateway**, so the value map is simply:

```
SBSH              -> SBSH
Trusted Connector -> Trusted Connector
BAF               -> Gateway
```

⚠️ The important half of that answer is **not** the mapping. It is an ELIGIBILITY rule, and it is
recorded in `grant-definitions.md` as dimension **D12**: receiving BAF makes a company Gateway-eligible
on the strength of the award alone — no NAICS test, no age test. That means the measured Gateway
cohort of 78 is a **floor**, not the cohort, and must be re-measured once `grant_program` is populated.

⬜ Also unresolved: BAF is identifiable today only from the opportunity's NAME, which is not a field
anyone can report on. If BAF grants are to count for Gateway, `grant_program` has to be the record of
it — which is an argument for backfilling that one record from the opportunity name and asking Alex to
set the contact field going forward.

---

## Applied — `activity_date` repaired, and `grant_reason` becomes an enricher (2026-09-03)

Zach settled both open questions:

> *"If we can update Activity_date then we should use close date or status change date for the grant
> activities. Same for program acceptance though we aren't focusing on that right now."*
>
> *"I think we might want to build an enricher for reason for grant on the activity. It could read the
> line items from the grant activity that get copied over and probably make a pretty strong
> determination. I am fine with an enricher over a reason for grant because reason for grant on the
> application won't always be completed or right. And if the line items on the grant change due to an
> amended agreement I want the grant activity to have the last version of the line items instead of
> the first."*

### 1. `activity_date` ← `opportunity.lastStatusChangeAt` — done

**57 of 64 rewritten, 7 already correct. A re-run reports all 64 `noop`.**

`lastStatusChangeAt` is the close date — the moment the opportunity's status became won or lost —
and it is 64/64 populated. `lastStageChangeAt` was deliberately **not** used: it is the last STAGE
move, which for the 36 records at Closed Won is when receipts were accepted, and it disagrees with the
close date on 34 of 64.

⚠️ **Scope correction to the finding as first reported.** I said every period-filtered report was wrong
for those 52 records. Measured: the dates were wrong on 57, but only **5 cross a half-year boundary**
and therefore change reporting period. The rest moved within the same half-year. The dates still
mattered — TC col S is a date the funder reads — but the period damage was 5 records, not 52.

Done as its own script (`scripts-ts/grant-activity-date-repair.ts`) with its own dry run, because it
rewrites a field the ingest path guards. Every write is in the change log with the reason.

🙋 **Program acceptance has the same shape and was NOT touched** — Zach: *"we aren't focusing on that
right now."* 84 `program_acceptance` records come from the same adapter and very likely carry the same
frozen ingest date. Worth the same repair when it comes up.

### 2. `grant_reason` — an enricher over the line items, not a field copy

`lib/enrichment/enrichers/grantReason.ts`, a `RecordEnricher` like the resource tagger.

**Why the line items beat the application text, measured:**

| Source | Coverage | |
|---|---|---|
| `contact.please_do_into_detail…` (the application) | **17/64** | what was *requested*, frozen at submission |
| approved line items on the activity | **54/64** | what was *contractually agreed*, and moves with an amendment |

The amendment case Zach raised is handled by *when* the enricher runs, not by anything inside it: it
reads whatever the activity currently holds, so re-running after the line items change yields the new
reason. Which stage triggers the field copy is what decides which version is on the record.

The enricher deliberately does **not** read the application text. Two sources for one field is how a
record ends up with a reason nobody can trace; the line items win, and the applicant's own words stay
on the contact for anyone who wants them.

**The hazard is the padding.** The form fills all ten slots: 49 of 64 records carry ten, and the tail
reads `$0 / [n_a] / "N/A" / vendor "N/A"`. Handing that to a model invites it to invent a use for
nothing, so a slot counts only with a positive amount AND a non-placeholder description. 10 tests pin
that, including every placeholder spelling seen on live.

**Sample dry run (5 records), unedited:**

```
Beautifully Savvy LLC      5 items $4,168   conf 0.9
   Funded product photography services, manufacturing equipment, and inventory
   supplies including raw materials and packaging for a personal care product line.
RPG Broadcast Consulting   1 item  $5,935   conf 0.6
   Funded the purchase of an enclosed trailer for general working capital purposes.
Sandhill Cr…               5 items $8,888   conf 0.9
   Funded brewing equipment for operational use.
RJ's                       2 items $11,300  conf 0.9
   Funded a slushy machine and bench seating for a party section.
1 Source Solutions LLC     4 items $5,170   conf 0.6
   Funded marketing consulting services and vehicle wraps for branding purposes,
   along with operational equipment.
```

No dollar figures, no vendor names, no outcome claims, no praise — all four are prompt rules, because
this text goes to a funder. Confidence is recorded as provenance, and Low is flagged to verify.

### 🔴 A third field is silently dropped: item 3's expense category

Found while reading the line items: **`contact.expense_category_item3` is missing an underscore.** The
activity expects `expense_category_item_3`, so it key-matches nothing and is dropped on **every**
submission — the exact failure mode as the bank-loan field. It is visible in the data on every record:
item 3 always arrives with an amount, description and vendor but no category.

This one needs no new field. Both fields exist; only the key differs — so it belongs in the alias map
this brief already proposes for `grant_program` and `grant_reason`:

```
contact.direct_grant_program        -> activities.grant_program        (value map: BAF -> Gateway)
contact.expense_category_item3      -> activities.expense_category_item_3
```

The enricher tolerates the gap today (amount + description + vendor is plenty to reason from), so
nothing is blocked — but the category is a funder-reportable classification and should not stay lost.

---

## `grant-reason` is a gated enricher (2026-09-04)

Zach: *"Can we set this up as a gated sync? I think that is a perfect way to make sure the
configuration is good."* Done — it is now a first-class entry in the enricher registry, so
`/enrichment` lists it and its gate is editable there without a deploy.

**The shipped default gate:**

```
activity_type ∈ {grant}
  AND
grant_status  ∈ {Agreement Executed, Receipts Received, Closed Won}
```

The status half is **Zach's amendment requirement expressed as configuration**. Before the agreement
is executed the line items are a *proposal*, so a reason derived from them would describe what was
asked for rather than what was funded — and fill-empty semantics would then freeze it. **Closed Lost
is deliberately excluded**: a declined application has line items but was never funded, and "Funded …"
would be a false statement on a funder-visible record.

**Population, measured:** 64 grants → **62 pass the gate** → 52 produce a reason (28 high, 22 medium,
2 low) and 10 are skipped for carrying no line items. The 2 held back by the gate are exactly the two
records with no `grant_status` — an absent status is not evidence of execution.

`activity_type` is checked BOTH in the gate and in the enricher's own code, deliberately: the gate is
editable, and someone widening it must not be able to give an intake record a grant reason.

### 🔴 The gate found a real bug in its first run — which is the argument for gating

The first gated dry run passed **0 of 64**. Not a config typo: **every select field stores its option
KEY (`closed_won`) while a person sees its LABEL (`Closed Won`)**, and `membershipMatches` compared
raw lowercased strings. So a gate written from the labels visible in GHL could never match any
multi-word option — and it failed **silently**, because a gate that never passes is indistinguishable
from having no work to do.

This is the third instance of the same label-vs-key failure in this codebase:

| Where | Symptom |
|---|---|
| `didPersist` (`MULTIPLE_OPTIONS`) | 57 referral records reported dirty and rewritten on **every** run |
| `resolveOptionKey` (`SINGLE_OPTIONS`) | already handled — the one place that got it right |
| `membershipMatches` (every enricher gate) | a gate written with labels matches **nothing**, quietly |

Fixed in `lib/enrichment/gate.ts` with `optionToken()` — both sides fold to lowercase with runs of
non-alphanumerics collapsed to `_`, so `Closed Won` and `closed_won` are the same token. It applies to
**every** gate (contact, company, resource, activity), so any gate anyone writes from the UI's labels
now works. Tests assert both spellings pass and both spellings of an excluded value fail.

Had this run un-gated as a plain script, it would have written 52 reasons and nobody would have
learned that every gate in the system was label-blind.

---

## Applied — the alias table, and the enricher (2026-09-04)

Zach: *"go ahead and work without checking back."*

### `grant_reason` — 52 written, and a re-run is free

```
64 grants → 62 pass the gate → 52 written (29 high · 21 medium · 2 low), 10 skipped (no line items)
re-run: 52 skip:already-has-a-reason, 10 skip:no-line-items — no rewrites, no repeat AI calls
```

**The idempotency exposed a half-served requirement, now closed.** Skipping any record that already
has a reason means an **amended** agreement would keep the first version's reason forever — the line
items follow the amendment (the form re-copies them) but the derived text would not. Zach's actual ask
was the opposite: *"if the line items on the grant change due to an amended agreement I want the grant
activity to have the last version."*

So the enricher now records a **fingerprint of the items a reason was derived from** in its change-log
rationale (`[items:5:kf3p1x]`), and the runner compares:

| | |
|---|---|
| fingerprint matches | skip — the reason still describes the current items, costs nothing |
| fingerprint differs | **recompute** — the agreement was amended |
| no fingerprint (written before this) | skip, and say `--overwrite` refreshes it |

Amount is in the fingerprint, so a renegotiated figure on unchanged descriptions counts as a change;
order is normalised, so re-slotting the same items does not. Six tests pin it.

### The alias table — 3 silent drops, closed

`FIELD_ALIASES` in `sources/form.ts`. The derived key-match stays the rule; this is the declared list
of exceptions, and every entry says why it exists.

```
direct_grant_program    → grant_program              (+ value map: baf → Gateway)
expense_category_item3  → expense_category_item_3    (a missing underscore)
```

`bank_loans_received_in_the_last_6_months` needed no alias — the activity field simply did not exist,
and creating it on 09-03 made it key-match.

**Proven on live data, not just in tests.** A dry run of the grant form path over the 51 contacts that
hold answers:

```
ALIASES FIRED (fields that do NOT key-match, carried by the declared table)
    50×  expense_category_item3 → expense_category_item_3
    50×  direct_grant_program   → grant_program
```

Fifty grant records were losing both fields on every submission. `grant_program` is the one that
matters most: it is what makes Zach's BAF→Gateway eligibility rule (D12) computable at all, since BAF
was otherwise identifiable only from an opportunity's NAME.

Aliases are reported on the ingest result and printed by the runner **by design** — the table exists
because these fields were dropped silently, so the aliases themselves must never become the new silent
thing. If someone renames a contact field, that count goes to zero and says so.

### 🔴 `--no-create` added, because the dry run found one

The dry run reported `would-update: 50` and **`would-create: 1`**. This runner's own header warns what
that means: the contact's Direct Grants opportunity did not resolve, so the form would mint a
**standalone** grant activity beside the one the pipeline already made. That is the duplicate class
this project has already paid for twice — 54 near-duplicate grants on 2026-08-19, and 7 real ones on
the sheet import.

A backfill's job is to fill fields, never to invent records. `--no-create` plans each contact first and
skips anything that would create, reporting it for a person instead. The apply ran with it.

### Verified against live after the applies

```
52/64  grant_reason              (was 0/64 on 09-03)
49/64  grant_program             (was 0/64)  — 41 sbsh · 8 trusted_connector · 15 empty
49/64  expense_category_item_3   (was 0/64)  — the missing underscore, closed
 0/64  award_amount              ⬜ not built (Zach: "not super worried about the backfill data")
 0/64  award_date                ⬜ not built; recoverable for only 26 of 64 anyway
64/64  activity_date             repaired to the close date on 09-03
```

A crude scan for reasons breaking a prompt rule (dollar figure, vendor name, outcome claim, praise)
flagged **1 of 52**, and on reading it that is a false positive: *"through multiple vendors
specializing in apparel production"* uses the word generically rather than naming a supplier. No real
violations.

`grant_program` shows 15 empty because those contacts never answered the question — the alias carries
whatever is there and invents nothing. Still **0 BAF** among the 64, so D12 remains latent: the rule
is now computable, but nothing currently exercises it.

### ⬜ Still open on this brief

- `award_amount` ← `opportunity.monetaryValue` (64/64 available, $347,311.63 total) and `award_date`
  (26/64 defensible). Deprioritised by Zach, not blocked.
- Wiring the field copy into the **opportunity path** so a NEW grant populates itself at Execute
  Agreement / Closed Won, rather than needing `form-ingest-run.ts`. This is brief item 4 and the last
  structural piece; the alias table it depends on now exists and is proven.
- 🙋 **`travis page`** has grant answers but no Direct Grants opportunity, so the field copy has
  nowhere to merge. `--no-create` refused to mint a standalone record. Link the contact to its
  pipeline record and re-run, or decide it is not a grant.
- 🙋 **`program_acceptance` very likely carries the same frozen ingest date** the grants did (84
  records, same adapter). Zach: *"same for program acceptance though we aren't focusing on that right
  now."*
