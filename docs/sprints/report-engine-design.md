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

## What this asks of Sprint B

- Phase 4 (program acceptance) is now **load-bearing for reporting**, not optional. Build it with
  enrollment intervals in mind: company, program, start date, and a route from pipeline stage →
  program.
- Keep activities honest and atomic; resist adding report-shaped fields to them.
- `program__grant_association` on an activity = origin hint only. Reporting reads rules, not tags.

## Acceptance (unchanged from the roadmap)

Regenerate a real submitted TC + SBSH sheet from canonical data and match it.
