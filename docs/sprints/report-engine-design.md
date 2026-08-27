# Sprint C — the report engine: how activities become a funder report

> Design note, 2026-08-19, written while Sprint B is landing (the roadmap says to write it then).
> Settles one question that has to be answered BEFORE Sprint B phase 4, because it decides what
> program-acceptance records are *for*: **where does grant attribution happen?**

## The question

Zach: *"we will build in the capability to define grant eligibility rules. Then we will have a log
of activities and we will have rules for eligibility. When we run a grant report we tell you which
grant, and you take the desired output format, the pre-defined eligibility rules, and find all
activities associated to eligible companies for that time period… maybe it does make sense to have
the engine tag activities to Programs/Grants. But I would still want that done via an
enricher/grant-reporting-engine."*

Three places attribution could live:

| | Where | Verdict |
|---|---|---|
| A | Stamped at **ingestion** (the calendar's route sets `program__grant_association`) | ❌ wrong — see below |
| B | Computed at **report time** from rules | ✅ the source of truth |
| C | Materialized by an **enricher** onto the record | ✅ but only as a *derived* view of B |

## Why not at ingestion

`CANONICAL_REPORTING_MODEL.md` already contains the argument:

> All contracts so far are MEDC-funded and all fund the **same underlying activities**, differentiated
> by **eligibility lens** (program tag, geography, company type/stage).

One activity can count for several grants, or for none, and which is which is a *lens*, not a
property of the meeting. Concretely, three ways an ingestion-time tag goes wrong:

1. **The inputs arrive later than the activity.** SBSH eligibility is CDFI Investment Tract /
   Qualified Census Tract / Rural MI county / SEDI-owned / COVID impact — company firmographics
   produced by the geo enricher, which may run *after* a meeting is logged. A tag written at
   ingestion is computed before its own inputs exist.
2. **Rules change.** Funders revise criteria between periods; a stamped tag never re-evaluates, and
   nothing in the system would tell you it is now wrong.
3. **It is unfalsifiable.** A frozen tag with no record of the rule that produced it can't be
   audited, which is precisely what a funder audit asks for.

The failure mode is the dangerous kind: the numbers still look plausible.

## The design

**1. Activities stay atomic facts.** What happened, when, with whom, from which source. This is the
roadmap's principle 4 ("GHL stores atomic facts only; aggregates are computed at report time") and
Sprint B already honours it.

The one thing ingestion *may* record is **origin**, which is a fact: "this meeting was booked on the
SAMA calendar." Sprint B's route config can stamp `program__grant_association` for that reason. It is
an origin hint for humans reading the CRM — **the report engine must never read it as eligibility.**
With calendar groups becoming meeting types (Intake / Technical Assistance), most routes won't set it
at all.

**2. Program ENROLLMENT is the missing fact — and it is what phase 4 produces.**
Attribution is derivable once you know *which programs a company was in, when*:

```
activity (company C, date D)  ×  enrollment intervals for C  →  programs in effect at D
```

Sprint B phase 4 (an opportunity reaching a pipeline stage → a Program Acceptance activity) is what
creates those intervals. That reframes phase 4: it is not a nice-to-have seventh activity type, it
is **the join that makes activity→grant attribution computable at all.** Worth adding an exit/
completion event later so an interval has an end, not just a start.

**3. Eligibility is versioned config, per grant.** Three filters, each reusing machinery that exists:

- **Company lens** — geo-disadvantaged, county, stage, NAICS, LARA ID present. The enricher filter
  model (`EnricherFilter` / `EnricherGroup`, already in Postgres for gates) is the same shape and
  should be reused rather than reinvented.
- **Activity lens** — which activity types count, and any per-type conditions.
- **Period** — the reporting window, against `activity_date`.

Config, not code, is the roadmap's principle 3: adding a grant must not need a deploy.

**4. The enricher materializes, it does not decide.** Zach's ask — visible tags on the record — is
right, with one constraint learned the hard way in the Wix repair: a derived value written back must
be a **`derivedFrom` field that recomputes when its drivers change**, carrying provenance (rule set +
version + when). Otherwise it churns, or silently goes stale, which is the same failure as (1) above
wearing a different hat. The stored tag is a cache of the rules, never the authority.

**5. Snapshot every report run.** A submitted number must stay reproducible even after rules change:
persist the run — grant, period, rule-set version, the activity ids selected, and the output. That,
not a frozen tag, is what makes an audit answerable.

## The forward flow (Zach, 2026-08-19) — and why it changes the emphasis

> *"Intake survey submitted → appointment scheduled → enrichers and syncs run → appointment date
> comes → activity logger runs → activity enriched with program/grant based on eligibility and
> definitions, and maybe the focus of the meeting from the Zoom notes."*

**Measured, and the premise holds.** Across 137 booked appointments the gap between booking and the
meeting is a **median of 11.9 days** (p10 = 44 hours; only 4% are booked inside 24 hours, and none
inside an hour). The intake survey also fires the contact-change webhook, so enrichment runs in real
time rather than waiting for the nightly job. By the time an activity is created, the company's
firmographics are populated — the "tag computed before its inputs exist" failure does not apply to
the forward path.

So **tag the activity when it is created.** That is Zach's flow, it is correct, and it makes the
report engine simpler and the CRM readable.

**What stays true regardless of timing**, and is the whole reason the tag must remain recomputable:

- **Corrections happen.** An address fix, a re-scored stage, a late LARA match all change eligibility
  after the fact.
- **History predates the flow.** There are 72 backfillable intake appointments right now that were
  never enriched in this order.
- **Rules get revised** within a grant's life.

*(Corrected 2026-08-19 — an earlier draft of this note claimed a new grant means re-evaluating every
prior activity. It does not: see the period rule below, which bounds it.)*

**Therefore: write the tag eagerly, treat it as a materialized view, and refresh it on four
triggers** — (1) activity created, (2) the company's firmographics change (fan out to that company's
activities, the same shape as the down-sync's company→contacts fan-out), (3) a rule-set version bump
or a new grant, (4) immediately before a report run, so a submitted number is never computed from a
stale tag. The tag carries the rule-set version that produced it; disagreement between tag and rules
is then detectable rather than silent.

That is the synthesis: Zach gets the tag on the activity from day one, and the numbers still survive
a rule change.

## THE GRANT PERIOD BOUNDS EVERYTHING (Zach, 2026-08-19)

> *"Grants will have defined grant periods. When we get a new grant for our LOCAL program, we don't
> need to tag the existing log of intake meetings that have already occurred — just ones that take
> place within the grant period and qualify. This will be true for all activity types."*

Correct, and it is already how `CANONICAL_REPORTING_MODEL.md` defines every KPI: *"COUNT DISTINCT
Company where Service Activity type=TA, modality=1:1, **in TC period**"*, *"served **in period**"*,
*"with a Service Activity **in period**"*. The period is not a new concept — it is the selection
predicate the model always had. Making it a first-class field on the grant definition is what turns
it from prose into config.

**A grant definition therefore carries: period start, period end, reporting cadence within it, the
eligibility rules, and a version.** An activity outside the period cannot qualify, full stop.

This is a significant simplification, because **the period bounds every re-evaluation**:

| Trigger | Scope of work |
|---|---|
| Activity created | evaluate against only the grants whose period contains its date — a small set, not every grant ever |
| Company firmographics change | re-evaluate that company's activities **inside open grant periods**, not its whole history |
| New grant onboarded | evaluate **only activities inside that grant's period** — for a forward-dated grant, that is *zero* historical work |
| Rules revised | same, bounded by the grant's period |
| Before a report run | refresh the run's window only |

So the temporal model is three simple pieces:

```
grant period      |------------------------|      (interval, per grant)
enrollment        |--------------|                (interval, per company+program — phase 4)
activity                    •                     (point in time)

qualifies  ⇔  activity date ∈ grant period
              ∧ company passes the grant's company lens
              ∧ (if required) company enrolled in the program at that date
```

Two consequences worth stating:

- **The tag is a SET, per (activity, grant)** — not one program value. Periods overlap, and the
  canonical model's whole premise is that the same activity is claimed through different lenses.
- **Eligibility is evaluated AS AT the activity date**, not as at today. A company that leaves a
  qualifying tract, or graduates a program, does not retroactively disqualify the meetings it had
  while it did qualify. This is a further argument for tagging at creation: that is precisely the
  moment the state is right.

**The backdated-contract case is handled at SETUP** (Zach, 2026-08-19). MEDC contracts are sometimes
executed with a period that already started (signed in November, period starting July 1). This needs
no special code path — it is just a non-empty initial scope:

> When a grant is created with `period_start` in the past, the setup flow computes the activities in
> `[period_start, min(today, period_end)]`, reports the count, **dry-runs** the tagging, and applies
> on confirm.

Same machinery as the forward path, and the same dry-run → review → apply discipline every batch here
follows — which matters most at exactly this moment, because it is the one time a rule change touches
history in bulk. Reports already submitted are unaffected: their runs are snapshotted (see 5 above).

## Meeting focus from Zoom notes — it fills a real, current gap

`service_topic` (coaching / marketing / operations / finance / product-tech) is **required** for a
Technical Assistance activity in the manual form, but the appointment adapter cannot know it: it can
only apply a fixed default from the route, so every ingested TA activity has the same topic or none.
Deriving it from the AI Companion summary is the missing per-meeting input, not a nicety.

Shape is already proven here — it is the readiness tagger over again: AI reads text, returns
structured tags, written through a `derivedFrom` guard so it only rewrites when the summary changes.
Same for a short meeting summary into `activity_notes`.

## What this asks of Sprint B

- Phase 4 (program acceptance) is now **load-bearing for reporting**, not optional. Build it with
  enrollment intervals in mind: company, program, start date, and a route from pipeline stage →
  program.
- Keep activities honest and atomic; resist adding report-shaped fields to them.
- `program__grant_association` on an activity = origin hint only. Reporting reads rules, not tags.

## Acceptance (unchanged from the roadmap)

Regenerate a real submitted TC + SBSH sheet from canonical data and match it.

---

# The output half — a report definition is a MAPPING SET (Zach, 2026-08-21)

> Zach: *"take a grant, create a definition of eligibility, and then take the reporting spreadsheet
> and make a mapping interface similar to what we have for the Syncs, but for grant mapping. I could
> map a spreadsheet column to the contact, company, or activity because we have associations for all
> of them. We would probably start with an activity, then search by association if a column was
> mapped to a contact or company field."*

This is the half the design above was missing. Everything before this section settles *which
activities qualify*; nothing said how a qualifying activity becomes a **row of a funder's
spreadsheet**. The answer is the shape the app already has three times over: **config-as-data rows,
edited in a UI, executed by a generic engine.**

A **report definition** = the eligibility rules (above) + a **column mapping set** (this section).
Adding a grant, or absorbing a funder's revised template, is then editing rows — not a deploy. That
is roadmap principle 3, applied to the output side.

## Why the sync mapper is the right ancestor — and where it stops

Reuse, not reinvention. What carries over directly:

| Sync-engine primitive | Reused as |
|---|---|
| `syncs` + `field_mappings` rows (config-as-data, versioned) | `report_defs` + `report_columns` |
| `syncs.association_id` traversal spec, `scalar:<source\|target>:<field>` (`lib/sync/traverse.ts`) | **Zach's association hop** — activity → company → contact |
| `dryrun.ts` coercion + option-key→label resolution | funder cells want the LABEL, and GHL stores the KEY |
| `wix_mapping_rows.valueMap` (per-row label rewriting) | funder vocabulary mapping (see below) |
| `GateEditor` filter groups (`EnricherGroup`/`EnricherFilter`, AND/OR, two levels) | **the eligibility editor, already built** |
| `/mappings` hub + `/mappings/[id]` editor, live field catalogs in every picker | `/reports` + `/reports/[id]` |
| dry-run → review → apply | generate → review → submit, with the run snapshotted (§5 above) |

**What does NOT carry over is the entire write path**, and that is the good news: a report is a
**read-only projection**. No modifier diffs, no `{add,remove}`, no read-back verification, no
convergence guards, no churn detection, no `noop`. Every hard-won rule in `CLAUDE.md` about object
writes is simply out of scope here. Do not port it.

## Three kinds of column binding, not one

Zach's "map a column to a contact, company, or activity field" covers two of the three. The measured
templates need all three (see `funder-field-trace.md`):

1. **Direct** — read a field off the row's own activity.
   `Date of Service` → `activity_date` · `Notes` → `activity_notes`
2. **Association hop** — traverse, then read. *This is Zach's insight, and the traversal spec already
   exists.* `County` → activity → company → `business.county` · `Email` → activity → company →
   contact → `email`. The census says the hop is safe: **99% of companies resolve a linked contact
   with a name and an email**, and Sprint B's backfill had zero records blocked by a missing company.
3. **Aggregate** — a COUNT/SUM over the selected row set, not a field read. This is most of TC's KPI
   sheet and all of SBSH's `Reporting Datafields`: *"Total Unique Businesses Served"* =
   `COUNT DISTINCT company`, *"Total Follow on Funding"* = `SUM` over eight metrics fields. A column
   of this kind binds to an **expression over the rows**, so it needs the row set to exist first —
   which makes the row tabs a dependency of the aggregate tabs, not a sibling.

A fourth, narrower kind is worth calling out because TC's central block needs it:

4. **Row predicate** — TC cols L–Q (`1:1 Technical Assistance`, `Group Technical Assistance`,
   `Hosted a Tech or Innovation event`…) are **marks on the row**, not values: a boolean over the
   row's own activity (`activity_type='Technical Assistance' AND modality='1:1'`). Same filter-group
   editor as the eligibility lens, scoped to one column instead of the whole report.

## Row grain belongs to the definition, not the engine

"Start with an activity" is right for three of the four grants — and wrong for the fourth:

| Grant | Grain | Row source |
|---|---|---|
| Trusted Connector | one row per **service event** | activity |
| SBSH `SB Data` | one row per **event** (LARA ID dedupes) | activity |
| Industry 4.0 | one row per **event** | activity |
| **Gateway** | one row per **COMPANY** | company, joined to its latest metrics snapshot — **no activity rows at all** |

So grain is a property of the report definition: `activity` or `company`. On a company-grain report
the hop runs the other way (company → its activities, to decide whether it was *served* in the
period), which the traversal spec already expresses in both directions (`scalar:source:` vs
`scalar:target:`).

## What a report mapper needs that the sync mapper doesn't

- **Funder vocabulary mapping.** A funder cell is not a GHL label. SBSH col W wants exactly
  `SEDI-owned` / `Geographic Area defined in Grant Agreement` / `Disproportionate negative economic
  impact as a result of COVID`; i4.0 wants one of 8 service types; Gateway's NAICS column accepts
  only its **31 listed codes**. `wix_mapping_rows.valueMap` is exactly this mechanism — generalize it
  rather than hardcoding per-funder label tables.
- **Output shape.** A workbook has tabs, a header row that is not row 1 (TC and SBSH both start at
  row 3), merged banner groups, and column order that must match the funder's file. The definition
  carries sheet + header row + column position; `xlsx` writes it.
- **Dedup scope.** Dedup is *within* a report, not across grants (that was settled in
  `CANONICAL_REPORTING_MODEL.md`). Both TC and SBSH ship `__` / `Duplicate` helper columns, and SBSH
  names LARA ID as the key — which is measured at **31% populated**, so the engine needs a documented
  fallback (company id, then name+address) rather than trusting the funder's stated key.
- **Provenance per cell.** When a regenerated sheet doesn't match a submitted one, the question is
  always *which record produced this cell*. Keeping the source record id behind each value is what
  makes the acceptance test debuggable instead of a staring contest.

## Where the seed data comes from

`funder-field-trace.md` (2026-08-21) already binds **~150 template columns** to a named GHL field,
association hop, or aggregate, with live population measured for each. That document is the initial
`report_columns` row set for all four grants — the mapping UI starts populated and reviewable rather
than empty. It also names the 7 columns with no field anywhere and the 7 derivation decisions still
open, which are precisely the rows that would otherwise be silently blank.

## Sequencing note

The trace found that the engine can be built against this design, but its **acceptance test cannot
pass yet**: `metrics` and `workshop_event` have zero records, TA `modality` is unset, and the grant
headline fields are empty — so 5 of TC's 8 required KPIs have no source regardless of how good the
mapper is. Those are small, targeted fixes (`funder-field-trace.md` §6.1–6.5). Build the mapper
against the columns that *do* resolve, and let the fixes land in parallel.

## Selection has TWO lenses, not one (Zach, 2026-08-21)

The clarifying case is Gateway:

> *"We would use all of the activities to determine who we served, but mostly use metrics data to
> populate the sheet… we are not really logging an intake meeting on the companies served spreadsheet
> for gateway. But if we had an intake meeting with a gateway eligible company in the reporting period
> we should list them on the sheet. If we have metrics then we use those metrics. If we don't then we
> put in 0s."*

So "which activities get reported" is really two independent questions, and conflating them is how a
report ends up either missing companies or double-counting them:

1. **QUALIFY** — which activities make a company count as *served* in the period. Gateway: **any**
   activity type. An intake meeting never appears as a row, but it is what puts the company on the sheet.
2. **EMIT** — what actually becomes rows and cells. Gateway: **one row per company**, populated from
   the metrics snapshot, **zeros when there is no snapshot** (the company still appears — absence of
   an outcome survey is not absence of service). TC/SBSH/i4.0: **one row per qualifying activity**.

A definition therefore carries both, and `emit` is where the grain lives. Restating §"Row grain
belongs to the definition" more precisely:

| Grant | Company lens (qualify) | Activities that qualify | Emit | Missing-data rule |
|---|---|---|---|---|
| **Gateway** | NAICS 4-digit ∈ the funder's 31-code list **AND** Michigan | **any** type | 1 row per **company**, cells from the period's metrics snapshot | **0s**, company still listed |
| **TC** | Michigan address, small business, interacting with LRL / LOCAL / SAMA | intake · referral · technical assistance · **program acceptance (LOCAL or SAMA)** · grant | 1 row per **activity** | — |
| **SBSH** | Michigan **AND** (SEDI-owned **OR** in a geographically disadvantaged business area) | same list, but **program acceptance = LOCAL only** | 1 row per **activity** | — |
| **i4.0** | Michigan manufacturers (NAICS 31–33) **OR** startups selling i4.0 solutions to manufacturers (may be out-of-state) | intake · technical assistance, from the program's own calendars/links | 1 row per **activity**, split across two tabs by company type | — |

**TC and SBSH differ only in their lenses, not their shape** — same activity types, same grain, and the
program-acceptance rule is one option value apart (SAMA counts for TC, not for SBSH). That is the
canonical-model premise holding up: same facts, different lens.

### Measured — what each lens actually selects today

| Lens | Companies | Note |
|---|---|---|
| Michigan address (**TC**) | **780 / 897** (87%) | across 5 spellings; 90 companies have a null state |
| Gateway NAICS ∧ Michigan | **78 / 897** (9%) | 88 match on NAICS alone; submitted Gateway sheets carry ~38 rows/period, so this is the right order of magnitude |
| Manufacturers 31–33 ∧ MI (**i4.0** tab 1) | **122 / 897** (14%) | |
| SBSH | **not measurable yet** | the qualifier field doesn't exist on the company — see below |

**The NAICS matching rule is now unambiguous.** We store **6-digit** codes (623 of 663 values) and the
funder's list is **4-digit**, so "the same or very similar" = **truncate ours to 4 digits, then compare
to the list**. Matching on all 6 digits would select almost nothing. Two things follow:
- Gateway's high-tech list and i4.0's manufacturing sectors are **different sets** — 131 companies are
  in NAICS 31–33 but only 88 are on Gateway's list (e.g. we hold `3327`, `3118`, `3399`, all
  manufacturing, none of them Gateway-eligible). Don't let one stand in for the other.
- The code list belongs in the grant definition as data, editable per grant, not hardcoded — funders
  revise these lists.
- Small hygiene tail: 17 NAICS values aren't 4/5/6 digits (13 are a single digit, one is 7) and 11 are `0`.

### This promotes the geo-disadvantaged gap from a blank cell to a blocked report

`funder-field-trace.md` §6.5 flagged that `business.geo_disadvantaged` holds HUBZone/Opportunity Zone
while TC col K and SBSH col W want SEDI-owned / grant-geographic-area / COVID-impact, and that the
right-shaped field exists only on the **contact** and is missing its third option.

Under the two-lens model that is no longer just a column that prints blank: **it is SBSH's row-selection
predicate.** Without it on the company, SBSH cannot decide which activities belong on the sheet at all.
It moves from "a cell is empty" to "the report cannot be built", and should be fixed before the SBSH
half of the acceptance test is attempted.

### Tabs carry their own lens

A tab is not just output shape — several tabs share a schema and differ only in selection, which the
definition has to express:

- **Gateway** has three: `Companies Served` (qualified in period), `Companies Created` (same columns
  **plus LARA ID**, companies created in the period), `Non-served reporting FOF` (has follow-on funding
  **and was not served** in the period — a deliberate inverse of the main lens).
- **i4.0** has two: `Small MI Manufacturers Served` vs `Other Companies Served` — split by company type,
  and the only place a grant legitimately reports out-of-state entities.
- **SBSH** has four `SB Data` tabs: one lens, sliced by quarter.

So: `report_def` = grant + period + version + company lens + column mappings; `report_tabs[]` = name +
header row + grain + a lens override + an emit rule. The quarterly slicing falls out of the period.

### i4.0 needs a decision before it can be built at all

Two blockers that are not field mappings:

1. **Its history lives in a different GHL sub-account** (shared with Centrepolis), which Zach expects to
   retire. Everything measured in this doc covers location `FgnVVv4smxyBNJKFZgJv` only, so **none of the
   i4.0 activity history is in the Activities object.** Either the engine reads across locations, or the
   sub-account is migrated first. Migration is the better answer — a cross-location read would put the
   idempotency ledger and the association graph in two places.
2. **"Startups selling i4.0 solutions to manufacturers" has no field.** It is a company-type
   classification, not a NAICS range (these companies may be out-of-state, and their NAICS is often
   software/engineering). `business.high_tech_business` (Yes/No/Unsure) is only 15% populated and asks a
   different question. This needs either a company tag or an enricher — and it is exactly the second
   i4.0 tab, so the report is half-blind without it.

Also: the program's dedicated intake / TA links become ordinary `activity_routes` rows once those
calendars live in the main account — no new mechanism, which is the point of routing being config.

### Still open

1. **SBSH and the tri-county rule.** `CANONICAL_REPORTING_MODEL.md` scopes SBSH to *"Jackson, Lenawee,
   and Hillsdale counties"*, and `contact.county` exists with exactly `{Jackson, Lenawee, Hillsdale,
   Other}` — which reads like the gate is real. The 8/21 framing gives SEDI-owned / geographically-
   disadvantaged instead. Is county **AND**ed with that, or has it been superseded?
2. **"Small business" for TC** — is there a size threshold (FTE or revenue), or does any Michigan
   company interacting with LRL/LOCAL/SAMA qualify? The lens selects 780 companies without one.
3. **Which metrics snapshot** a Gateway row uses is settled in principle (the snapshot whose
   `reporting_period` falls in the grant window) but needs the tie-break written down for a company with
   two snapshots inside one Gateway period — latest, or the one nearest the period end.

---

# Designing for grant N, not grant 4 (Zach, 2026-08-21)

> *"Think about a world where we add new grants every year and need to constantly come up with new
> ways to report on the new grant criteria and asks."*

The four current grants are a **sample**, not the requirement. Two of the decisions above were made
by looking at those four; both change when the horizon is "a new grant every year."

The useful discipline is to ask what actually varies between grants, using the four measured ones as
evidence rather than imagination.

## What varies, measured across the four

| Grant | Its company lens needs… |
|---|---|
| TC | set membership on a text field (Michigan, across 5 spellings) |
| Gateway | **prefix matching** — we store 6-digit NAICS, the funder's list is 4-digit |
| SBSH | set membership (county) **∧ a derived OR across four fields** (SEDI) **∧ interval containment** (enrolled in LOCAL at the activity date) |
| SBSH datafields | **numeric comparison ∧ date arithmetic** (Second Stage = FTE ≥ 10 ∧ revenue ≥ $1M; Early Stage = incorporated 1–3 years ago) |
| i4.0 | a classification **that does not exist yet** (develops advanced-manufacturing solutions) |

The existing `EnricherFilter` / `EnricherGroup` model — `{field, anyOf[]}` with AND/OR and two-level
grouping — expresses the **first** row and nothing below it. That is the real extensibility risk, and
it is not "can we add a grant record": it is **"can we express a predicate we have never seen before."**
Four of the five rows above already need predicate kinds the current filter model cannot state, and
that is before grant #5 arrives.

## Decision 1 — a named predicate registry, not a rules DSL

Grants compose **named, tested predicates**; they do not carry raw expressions.

```
sedi()                         → minority ∨ women ∨ veteran ∨ disabled  (any true)
geo_disadvantaged()            → the address lookup ≠ None
naics_in(list, depth = 4)      → truncate the stored code to `depth`, then match
county_in(list)                → set membership on business.county
in_state(code)                 → normalized state comparison (5 spellings of Michigan today)
enrolled_in(program, at_date)  → activity date ∈ a program-acceptance interval
age_years_between(field, a, b) → date arithmetic
numeric_at_least(field, n)     → numeric comparison
served_in_period()             → ∃ a qualifying activity in the window
```

Composition is **config**; each primitive is a small unit-tested function behind a registry, exactly
the shape `defaultRecordEnrichers` and the enricher registry already use. Consequences:

- Adding a grant whose criteria are familiar = **composing existing predicates. No deploy.**
- Adding a grant with a genuinely novel criterion = **one function plus a registry entry** — not an
  engine change, and it is immediately available to every future grant.
- **Deliberately NOT a general expression language.** A half-built query DSL is the classic failure
  here: it looks flexible, and then nobody can debug why a number moved. Primitives in code,
  composition in data, and the composition stays readable as text so a human — or a funder in an
  audit — can review the rule that produced a number.

## Decision 2 — canonical metrics sit BETWEEN columns and facts

This is the decision that changes from looking at four grants to looking at forty.

The same underlying quantity is asked for by several funders, in different words, over different
windows: **"jobs created" appears three times already** — Gateway `Jobs Created`, TC KPI 12 *(Number of
Jobs Created by Companies Served)*, SBSH `Projected New Full Time Jobs` — and *"businesses served"*
appears in all four with a different lens each time.

If columns bind straight to atomic facts, **every new grant re-derives every metric**, and grant #7's
jobs number will quietly disagree with grant #2's. The disagreement is invisible, because both look
plausible — the same failure class as the write-path bugs that cost us weeks.

So: three layers, not two.

```
funder column   →   canonical metric   →   atomic facts
(label, order,      (jobs_created,         (activities, companies,
 format, tab)        businesses_served,     metrics snapshots)
                     direct_grant_dollars,
                     referrals_to(kind))
```

A canonical metric is defined **once**, with its window semantics explicit, and each grant's column
binds to it with that funder's label and formatting. Two grants asking the same question get the same
number by construction; two grants asking deliberately *different* questions bind to different
metrics, and the difference is visible in config instead of buried in a formula.

## Decision 3 — the readiness report is GENERATED, not written by hand

`funder-field-trace.md` is a hand-built snapshot of ~150 columns. It was worth building — it is what
surfaced the empty activity families — but **it will rot**, and hand-writing one per grant per year
does not scale.

Make it an output of the engine. Given a grant definition and a period, the generator reports:

1. columns bound to **nothing** (a new funder always asks for something we don't collect — 7 today:
   Tribal, Decline to Answer, DUNS, Facilitated Revenue, Date of Follow-on Funding, Bank/Loan FOF,
   non-MI licensing),
2. bound columns whose **population is below a threshold** across the selected cohort,
3. the **cohort size** each lens selects (measured today: TC 780, Gateway 78, SBSH 346 → 283 when
   Lenawee drops, i4.0 manufacturers 122).

Then **onboarding grant #5 produces its own readiness report**, and "can we actually report this?"
is answered before anyone promises a number to a funder. An unbound column must be a **declared
state** the generator reports — never a cell that silently prints blank.

## Decision 4 — definitions are versioned data, and clonable

Already implied by the period + version fields; the yearly cadence makes two consequences concrete:

- **Rules change mid-grant.** Live example: SBSH drops Lenawee, moving its cohort 346 → 283. The
  definition is versioned, every run is snapshotted with the version that produced it, and a submitted
  number stays reproducible after the rule moves.
- **Version the lens and the column set SEPARATELY.** Funders reissue templates with cosmetic column
  changes far more often than they change eligibility. Re-pointing at a new template must not mean
  re-deriving the rules — and a renewal is then *clone last year's definition, bump the period*.

## Where the cost actually lives

Worth stating plainly, because it sets expectations for grant #5 and it is not the engineering:

| Kind of new grant | Cost |
|---|---|
| Familiar criteria, familiar asks | **config, an afternoon**, no deploy |
| One novel predicate | + one tested function |
| One novel *canonical metric* | + one metric definition |
| Asks for a field **we do not collect** | **a form change and a collection lag** — weeks-to-months, and no amount of engine work shortens it |

The last row is the real bottleneck, and today's measurements say so: LARA ID at 31%, the four
demographic flags at 39%, zero metrics snapshots. Grant #5 will hit the same wall. Which is an
argument for the generated readiness report above — it turns "we can't report that" into something
discovered at onboarding rather than at submission.
