# Grant definitions — the four active grants, precisely stated

> **Purpose.** One exact definition per grant: the eligibility lens, which activities qualify, what
> gets emitted, and where every number comes from. This is the spec the report engine is built
> against, and the seed config for the mapping sets.
>
> **Written 2026-08-24**, from Zach's scoping (8/21 + 8/24) and the funder's own submitted workbooks
> in `../../../Past Grant Reports/`. Column-level bindings live in `funder-field-trace.md`; the
> engine architecture lives in `report-engine-design.md`. Every cohort figure here is **measured
> against live** — re-measure with `npx vite-node scripts-ts/report-readiness-census.ts`.
>
> **⚠️ How to read the coverage figures (Zach, 8/24).** *"I am not worried about what data we already
> have in GHL. We are recording what we need to for each grant and the data gets better and better as
> we go. Existing data will have less context, but when they engage with us in the future for a
> specific grant program we will gather the necessary info."* So the percentages below are **reference,
> not gates** — they say how much *historical* context exists, which matters only for regenerating an
> already-submitted report. They are NOT a verdict on whether a grant can be reported going forward.
> Where a dimension is thin, the answer is to collect it on the path that serves that grant, not to
> block the build.
>
> **Deliberately NOT abstracted yet.** Zach's call (8/24): dial in the four real grants first, then
> have the scaling conversation. So this doc states each grant concretely and shares a **dimension
> vocabulary** (§1) — the abstraction should fall out of four real definitions rather than being
> guessed at. Marked **⬜ CONFIRM** wherever I am assuming.

---

## 1. The shared dimension vocabulary

Zach (8/24): *"Most of the time the eligibility criteria includes a set of SEDI, Geographic
disadvantaged business location, general geography, industry, business type, tech vs non-tech, small
business (per government definition)."*

That list is the recurring vocabulary. Each dimension below names the field(s) that answer it and how
much of the client base it can actually answer for — because a dimension we can't evaluate is a grant
we can't report, no matter how good the engine is.

| # | Dimension | Answered by | Coverage | Notes |
|---|---|---|---|---|
| D1 | **SEDI** | `minority_owned` ∨ `women_owned` ∨ `veteran_owned` ∨ `disabled_owned` (each `{true\|false}`) | **39%** answered · **259** companies SEDI-true · **543 unassessable** | A **derived OR**, not a stored field. Tri-state matters: all-four-false is "not SEDI"; all-null is "unknown", which for a funder is not the same as ineligible |
| D2 | **Geographically disadvantaged location** | `business.geo_disadvantaged` `[AI]` `{HUBZone \| Opportunity Zone \| both \| None}` | **77%** · **290** non-None | ⚠️ **The enricher answers a different question than SBSH's template.** SBSH defines the area as *2015 CDFI Investment Tract, 2020 Qualified Census Tract, or Rural Michigan county*; we evaluate HUBZone/Opportunity Zone. Overlapping, not identical — **⬜ CONFIRM** whether HUBZone/OZ is accepted as the determination, or the enricher must evaluate CDFI/QCT/rural |
| D3 | **General geography** | `business.state` · `business.county` `[AI]` (full 83-county MI list) · `city` · `postalcode` | state **87%** · county **82%** | State needs normalizing at read time — **27 distinct spellings**, MI appears as `MI` (626) / `Michigan` (145) / `Mi` (8) / `mi` (1); 90 companies have no state |
| D4 | **Industry** | `business.naics_code` `[AI]` | **74%** | We store **6-digit** codes (623 of 663 values); funder lists are published at 4-digit. Match by **truncating to the funder's depth** — never full-length equality. 17 values are malformed, 11 are `0` |
| D5 | **Business type** | `mi_registered_entity` (LLC/Corp/…) 27% · `physical_footprint` **2%** · `where_are_you_today` **4%** | **weak** | The vaguest dimension and the least populated. `i_am_selling` is **0/897 — a dead field**. Needs a decision about what "business type" means per grant before it can be a predicate |
| D6 | **Tech vs non-tech** | `high_tech_business` `{Yes\|No\|Unsure}` **15%** · `business_model` `{product-dev \| service \| both}` **4%** | **knowable for 165/897 (18%)** | **The thinnest recurring dimension.** NAICS (D4, 74%) is the only broadly-available proxy. See the escalation note below |
| D7 | **Small business (government definition)** | SBA size standards — **NAICS-keyed**, threshold in employees *or* annual receipts. Inputs: `naics_code` + `fte_current` (36%) or `annual_revenue` (31%) | **evaluable for 317/897 (35%)** | **No SBA size-standard table exists in the system.** Adding one is a self-contained piece of reference data. In practice nearly every company LRL serves is small, so this predicate may be near-vacuous — **⬜ CONFIRM** whether it needs real evaluation or a documented assumption |

| D11 | **Company age** | `business.date_of_incorporation` | 28% | Gateway gates on **< 10 years** (Zach, 8/24). `date_registered_in_michigan` (27%) is a near-twin — **⬜ CONFIRM** which one the funder means |

Three more dimensions the four grants need that aren't on the list above:

| # | Dimension | Answered by | Coverage |
|---|---|---|---|
| D8 | **Cohort program acceptance** | `program_acceptance` activities, carrying `program__grant_association` | **84** records: `local` 52 · `sama` 32 |
| D9 | **Served in period** | ∃ a qualifying activity for the company inside the window | 234 activities total |
| D10 | **Business stage** (SBSH's classification) | computed from `fte_current` + `annual_revenue` + `date_of_incorporation` | worst of 36% / 31% / 28% |

### D8 is NOT a company-lens gate — it only scopes which acceptance records count

Corrected by Zach 8/24 for both TC and SBSH. Enrollment in a cohort program is **not** a precondition
for a company's activities to qualify:

> *SBSH — "we don't need the company to be accepted into the LOCAL Fellows Bootcamp program to be
> eligible. That is definitely a big part of it. But any technical services or referrals delivered to a
> company that fits tri-county and SEDI or geo also works."*
>
> *TC — "we can also loosen this program interaction. For the cohort program acceptance both SAMA and
> LOCAL Fellows count. But technical services or referrals made for any MI small business would also
> qualify."*

So D8 appears in exactly one place: **which `program_acceptance` activities count for this grant** —
LOCAL or SAMA for TC, LOCAL only for SBSH. Every other activity type qualifies on the company lens
alone.

**This makes all four lenses purely company-ATTRIBUTE predicates**, which is a real simplification: the
lens never has to consult the activity graph, and it lines up exactly with the three-filter model in
`report-engine-design.md` (company lens × activity lens × period). My earlier drafts of TC and SBSH
over-constrained both by folding enrollment into the company lens.

### The reporting SUBJECT is "the business served" — which may be a contact with no company

Zach (8/24): *"For SBSH and TC we often don't need a company to be created yet. If the contact does not
have a company but their address is in the proper geos then this would also count."*

This is structural: the lens is evaluated against a **subject**, and the subject is a company **or** a
bare contact. Resolution order for any activity:

```
subject(activity) = its company, if one is linked
                  = otherwise the contact itself
attribute(subject, D) = company value if present, else the contact's own value
```

The contact object already carries a parallel set of every dimension — `contact.county`,
`contact.geographically_disadvantaged`, the four `..._owned_business_radio` flags,
`contact.naics_code`, `contact.lara_id_number`, `annual_revenue`, `number_of_full_time_equivalents_fte`
— which is what the contact↔company sync engine keeps in step for linked pairs. So there is a field to
read; the model just has to be told to read it.

**Measured: 451 of 1,537 contacts have no company.** But of those 451, the lens can barely evaluate any
of them today:

| Of the 451 company-less contacts | |
|---|---|
| Michigan address (**the TC lens**) | 96 (21%) |
| tri-county | 39 (9%) |
| SEDI (any of the 4 flags) | **1** |
| geo-disadvantaged | **0** |
| NAICS | **1** |

**The cause is worth knowing, because it is not a coverage problem that time fixes: the enrichment path
is company-only.** `business.geo_disadvantaged` and `business.county` are `[AI]`-enriched to 77% / 82%;
their contact-side twins are near-empty for unlinked contacts, because the enrichers run on companies
and the sync only mirrors values between *linked* pairs. A bare contact has no counterpart, so it never
receives an enriched value. Left alone, "no company needed" is true as policy and unusable in practice.

Two ways to fix it, and it is a product decision — **⬜ CONFIRM which:**

| | Approach | Trade-off |
|---|---|---|
| **A** | **Run the enrichers on contacts too** — county + geo-disadvantaged from the contact's own address | Honours "no company needed" literally. But only 13% of these contacts have a street address, so geo enrichment has little to work with, and NAICS enrichment needs a business description the contact record may not have |
| **B** | **Create a lightweight company at the point of service** and let the existing enrichment apply | Recommended. Every funder row is **business-shaped** anyway (Business Name, address, NAICS, LARA ID), so the report needs a business record regardless; it gives firmographics a home and a stable dedup key |

**The reason B is worth the extra record is a dedup hazard that survives review:** if period 1 counts
*"Jane Smith, no company"* and period 2 counts *"Jane's Bakery LLC"*, the cumulative TC sheet counts one
business twice, and both rows look perfectly plausible. A subject that starts as a contact and later
gains a company needs one identity across periods — which is much easier to guarantee if the company
exists from the first service event. (If A is chosen, this needs an explicit contact→company identity
carry-over rule.)

### ⚠️ Escalation — D6 changes the status of a closed item

Sprint A closed the stage scorer's "no-route" rate as **not a bug**: 857 of 895 companies have a blank
`business.business_model` because the intake question that feeds it is new and only ~3.5% of contacts
have answered it. That reasoning was correct *for the scorer*.

But D6 makes `business_model` / `high_tech_business` an **eligibility input**, not just a scoring
input — and *"tech vs non-tech"* is by Zach's account one of the most common grant criteria. At
**18% knowable**, a grant gating on it could only be reported *retrospectively* for about a fifth of
the client base.

Per Zach's framing above that is not a blocker — forward engagements collect what the grant needs. The
reason it is still worth flagging: the collection has to be **on the intake path before the grant
arrives**, because a criterion nobody asked for cannot be back-filled from a client who has already
been served. Cheap to add now, impossible to reconstruct later.

---

## 2. Trusted Connector (TC)

**Funder** MEDC · **Cadence** annual · **Template** row sheet (header row 3) + a Smartsheet KPI portal
· **Workbooks** 1, cumulative (`1st Report` / `2nd Report` / `Cumulative Report` tabs)

### Company lens — the loosest of the four
```
subject = company, else the contact itself     (see §1)
in_state('MI')            D3
∧ small_business()        D7   ⬜ CONFIRM whether this is evaluated or assumed
```
That is the whole lens. Zach (8/21): *"open state wide for any small business with a MI address that is
interacting with Lean Rocket Lab, our LOCAL program, or SAMA."* Then (8/24): *"we can also loosen this
program interaction… technical services or referrals made for any MI small business would also
qualify."*

So there is **no enrollment condition** — any Michigan small business we serve qualifies, and D8 only
decides which cohort-acceptance records count (below).

**Cohort measured:** **780 / 897** companies have a Michigan address.

### Qualifying activities
`intake` · `introduction_referral` · `technical_assistance` · `grant` — all on the company lens alone.
Plus `program_acceptance` where the program is **LOCAL or SAMA** (both cohort programs count for TC).

**Plus `workshop_event` — event attendees count (Zach, 8/24):** *"For TC we can also count event
attendees for technical service workshops and other events."* So an attending business is a served
business. All event types count — technical-service workshops, tech/innovation events, webinars,
roundtables — and attendance (not registration) is what qualifies: `attended = 'Yes'`.

⚠️ **This makes phase 6 a ROW SOURCE for TC, not just a KPI input.** The trace had `workshop_event`
feeding only the aggregate *"# attendees at technology and innovation events"* (required KPI 3). It now
also generates sheet rows, which raises phase 6's priority — TC's row count is materially incomplete
without it.

**⬜ CONFIRM the grain:** one row per attending business per event (my reading, since TC is one row per
service event), or do attendees only ever roll up into KPI 3?

### Emit
**One row per qualifying activity.** Plus the KPI sheet as aggregates over the same selection.
Geography is statewide, so there is no tab split.

### Where the numbers come from
`funder-field-trace.md` §2. Status today: **5 of TC's 8 required KPIs cannot be produced** —
`modality` is 0/13 (KPIs 7, 8), `workshop_event` is 0 records (KPI 3), the geo qualifier is a computed
column not yet built (KPI 2), and `referral_type` has no `Ecosystem Partner` option (KPI 16). Only
*"# total businesses served"* is ready as-is.

### Open
- **⬜ CONFIRM** the grant period start/end and which submitted workbook tab is the acceptance target.
- **⬜ CONFIRM** whether *"LOCAL Fellows"* means every `local` acceptance record, or only the Fellows
  Bootcamp specifically — the program interest list distinguishes **LOCAL Fellows Program** from
  **LOCAL Fast Track to Lending**, while the 84 acceptance records carry only `local` (52) and `sama`
  (32), so the data cannot currently tell them apart.
- TC col K's three-way qualifier is now a **computed column**: SEDI → `SEDI-owned`; else D2 non-None →
  `Geographic Area defined in Grant Agreement`; else the COVID branch from
  `contact.how_was_the_business_impacted_by_covid`. Emit the funder's literal string; store nothing.
- **⬜ CONFIRM** what counts as a *"networking or mentorship initiative"* (col O) and what falls under
  *"Other"* (col Q).
- KPIs 9–11 (LRL's own org jobs, staff PD) stay manual by design. KPIs 12–13 (jobs by companies
  served) **are** derivable once metrics activities exist.

---

## 3. Small Business Support Hub (SBSH)

**Funder** MEDC · **Cadence** quarterly · **Template** 4 quarterly `SB Data` tabs (header row 3) +
computed `Reporting Datafields` + narrative Success tabs · **Workbooks** 1 (Q4 2025)

### Company lens — the most restrictive of the four
```
subject = company, else the contact itself            (see §1)
county_in(['Jackson', 'Lenawee', 'Hillsdale'])        D3   → soon ['Jackson', 'Hillsdale']
∧ ( sedi() ∨ geo_disadvantaged() )                    D1 ∨ D2
```
Zach (8/21): *"That grant only serves work done for LOCAL for SEDI or Geo disadvantaged, and for
Jackson, Lenawee, and Hillsdale county. Soon to be just Jackson and Hillsdale."*

**Corrected 8/24 — LOCAL acceptance is NOT required:** *"we don't need the company to be accepted into
the LOCAL Fellows Bootcamp program to be eligible. That is definitely a big part of it. But any
technical services or referrals delivered to a company that fits tri-county and SEDI or geo also
works."* So the earlier `enrolled_in('LOCAL')` term is **removed from the lens** — it survives only as
the filter on which acceptance records count.

**The county list is versioned config, not a constant** — Lenawee's removal is a mid-grant rule change,
and it is exactly why definitions carry a version and runs are snapshotted.

**⬜ CONFIRM:** the effective date Lenawee drops. Activities before it must keep qualifying under the
version that was live at the time.

**Cohorts measured:**

| | Companies |
|---|---|
| In Jackson / Lenawee / Hillsdale | **528** (Jackson 384 · Lenawee 87 · Hillsdale 57) |
| …of those, SEDI | 214 |
| …of those, geo-disadvantaged | 215 |
| **…SEDI ∨ geo — the lens today** | **346** |
| **Jackson / Hillsdale only — the lens soon** | **283** |
| Unassessable (nothing answered either way) | 24 of 528 |

### Qualifying activities
`intake` · `introduction_referral` · `technical_assistance` · `grant` — qualifying on the company lens
alone, with no enrollment requirement. Plus `program_acceptance` where the program is **LOCAL only**
(SAMA acceptance never counts for SBSH — the one place TC and SBSH genuinely differ).

**⬜ CONFIRM** that `intake` and `grant` both belong here. Zach's 8/24 correction named *"technical
services or referrals"* explicitly; the template's col Y (`Date of Initial Intake`), col Z (`First Time
Served`) and cols AE/AF (direct grant) imply intake and grants count too.

### Emit
**One row per qualifying activity**, sliced across the four quarterly `SB Data` tabs by
`activity_date`. `Reporting Datafields` are aggregates over the same selection. Success tabs are
narrative, one company per quarter, assembled from company prose fields — not computed.

### Grant-specific rules from the template's Definitions tab (load-bearing)
Early-Stage = formed 1–3 years ago · Microbusiness = < 10 FTEs · New Business Start = created via the
Hub, < 12 months · **Second Stage = 10+ FTEs AND $1M+ revenue** · first-time-served = within the
previous 18 months · Direct Grant ≤ $20k, per-item ≤ $4,999, one per business · FOF **excludes** SBSH
grants themselves.

### Open
- **Period starts 2023-12-18** — the template constrains col Y (`Date of Initial Intake`) to ≥ that
  date, and expenditures are cumulative "since 12/18/23". **⬜ CONFIRM** the end date.
- **⬜ CONFIRM** D2's definition (HUBZone/OZ vs the template's CDFI/QCT/rural) — this one materially
  moves the cohort.
- Two columns have **no field at all**: `Tribal` and `Decline to Answer`. `Date of Follow on Funding`
  also has none — only the half-year `reporting_period`.
- **⬜ CONFIRM** which `service_topic` values map to `Small Business Support Services` (col AC).
- `Date of Initial Intake` should be **computed** as `MIN(activity_date WHERE type = intake)` —
  `business.date_of_initial_intake` is 0/897.

---

## 4. Gateway / SmartZone

**Funder** MEDC · **Cadence** semi-annual (April + October) · **Workbooks** 7 (Apr 2023 → Apr 2026)

### Company lens
```
naics_in(GATEWAY_31_CODES, depth = 4)              D4
∧ in_state('MI')                                   D3
∧ age_years_less_than('date_of_incorporation', 10) D11   (Zach, 8/24)
```
The 31 four-digit codes are the funder's own high-tech list, published on `Sheet1` of its workbook.
**It belongs in the definition as data** — funders revise these lists.

**Cohort measured:** 88 companies match on NAICS; **78** also have a Michigan address. Of those 78,
**38 have an incorporation date on file — 36 are under 10 years old and 2 are not** (known ages run
0.1 to 11.4 years). So the age criterion is a light filter on this cohort, which fits a grant aimed at
young high-tech companies. The submitted sheets carry ~38 rows per period, so the order of magnitude is
right.

**⬜ CONFIRM** two things about age: is it evaluated **as at the period end** (the natural choice for a
company-grain report) or as at the activity date? And does the funder mean incorporation, or
`date_registered_in_michigan`?

⚠️ **Gateway's high-tech list is not i4.0's manufacturing sectors.** 131 companies sit in NAICS 31–33
but only 88 are on Gateway's list — we hold `3327`, `3118`, `3399`, all manufacturing, none of them
Gateway-eligible. Keep the two lenses separate.

### Qualifying activities
**Any type.** Zach: *"we would use all of the activities to determine who we served, but mostly use
metrics data to populate the sheet… we are not really logging an intake meeting on the companies
served spreadsheet."* An intake meeting never becomes a row, but it is what puts the company on it.

### Emit — the case that proved `qualify` and `emit` are separate
**One row per COMPANY**, cells populated from that company's metrics snapshot for the period.

**Missing-data rule: zeros, and the company is still listed.** Absence of an outcome survey is not
absence of service.

**Three tabs, three different lenses over one schema:**

| Tab | Lens |
|---|---|
| `Companies Served` | qualified ∧ served in period |
| `Companies Created` | created in period (same columns **plus LARA ID**) |
| `Non-served reporting FOF` | has follow-on funding ∧ **not** served in period — the deliberate inverse |

### Open
- **⬜ CONFIRM the snapshot tie-break:** a company with two metrics snapshots inside one Gateway
  period — latest, or nearest the period end?
- **⬜ CONFIRM** what makes a company "created" — LRL involvement before incorporation? `Companies
  Created` also requires a **LARA ID**, which is 31% populated overall.
- All 11 outcome columns trace to the metrics activity, of which there are **0 records**. Gateway is
  the grant most completely blocked by that single gap.
- `Bank/Loan` FOF has a contact field but **no activity twin**, so it is dropped at ingestion.

### Worked example — Veriti (2026-08-24)
NAICS `541511` → 4-digit `5415` ✅ on the list · Bangor MI (Van Buren County) ✅ · one activity, an
intake on 2026-06-10 ✅ served · **no metrics snapshot → zeros**. Also incorporated 2026-07-01, three
weeks *after* the intake, which makes it a `Companies Created` candidate — except
`mi_registered_entity = "not_registered"`, so there is no LARA ID to report. Veteran-owned + HUBZone,
so SEDI ∧ geo-disadvantaged — but Van Buren County, so it **fails SBSH**.

---

## 5. Industry 4.0 Accelerator — deprioritized

**Funder** MEDC · **Cadence** quarterly · **Workbooks** 13 (2023 → 2026) · **Budget tab** $192,000

**Zach's call (8/21, reaffirmed 8/24): do this one LAST — because it has historically been tracked in a
system separate from the LRL GHL instance.** The grant is also expected to end at the end of the year,
so forward tracking may not be needed at all. Everything else in this doc can be built without it.

### Company lens — two populations, one per tab
```
tab 1:  naics_in(['31','32','33'], depth = 2) ∧ in_state('MI')     D4 ∧ D3
tab 2:  sells_advanced_manufacturing_solutions()                   ⬜ NO FIELD EXISTS
```
The only grant that legitimately reports **out-of-state** entities (tab 2's tech vendors).

**Cohort measured:** tab 1 = **122** companies (131 manufacturers, 122 in Michigan). Tab 2 is
**unmeasurable** — the classification does not exist.

### Two blockers that are not field mappings
1. **Its history lives in a separate GHL sub-account** (shared with partner Centrepolis, expected to
   retire). Everything measured in these docs covers location `FgnVVv4smxyBNJKFZgJv` only, so **none
   of the i4.0 activity history is in the Activities object.** Migrate rather than read
   cross-location — a cross-location read would split the idempotency ledger and the association
   graph across two places, which is how double-counting gets in.
2. **Tab 2 needs a new enricher** — "does this company develop advanced-manufacturing / i4.0
   solutions?" It is a classification, not a NAICS range: these companies are often out-of-state with
   software or engineering codes. `high_tech_business` is 15% populated and asks something else.
   Zach: *"we can decide if that is an issue we need to solve or not."* **Open decision, not committed
   work.** Veriti is the exemplar — AI quoting for CNC machine shops, NAICS 5415, fails tab 1, belongs
   in tab 2.

### Emit
One row per qualifying activity, split across the two tabs by company type. `Type of Service provided`
and `Status` are both derived from activity fields — maps proposed in `funder-field-trace.md` §5,
both **⬜ CONFIRM**.

Its dedicated intake / TA links become ordinary `activity_routes` rows once those calendars live in
the main account. No new mechanism.

---

## 6. The four grants side by side

| Dimension | TC | SBSH | Gateway | i4.0 |
|---|---|---|---|---|
| D1 SEDI | reported, not gating | **gating** (∨ D2) | — | — |
| D2 Geo-disadvantaged | reported (KPI 2) | **gating** (∨ D1) | — | — |
| D3 Geography | MI statewide | **3 counties → 2** | MI | MI (tab 1); out-of-state OK (tab 2) |
| D4 Industry / NAICS | — | — | **31 codes @ 4-digit** | **sectors 31–33 @ 2-digit** |
| D5 Business type | — | — | — | — |
| D6 Tech vs non-tech | — | — | implied by the NAICS list | implied by tab 2 |
| D7 Small business | **gating** ⬜ | implied | — | — |
| D11 Company age | — | — | **< 10 years** | — |
| D8 Cohort acceptance *(scopes which `program_acceptance` records count — never a lens gate)* | LOCAL **or** SAMA | **LOCAL only** | — | its own calendars |
| Qualifying activities | **6 types** — 5 + `workshop_event` attendees | 5 types, company lens only | **any** | intake + TA |
| Subject may be a bare contact | **yes** | **yes** | ⬜ presumably not (company-grain) | ⬜ |
| Grain | activity | activity | **company** | activity |
| Tabs | 1 (+ KPI sheet) | 4, by quarter | **3, different lenses** | 2, by company type |
| Missing outcome data | — | — | **zeros, still listed** | — |
| **Cohort today** | **780** | **346 → 283** | **78** | **122** + unmeasurable |

**TC and SBSH are the same report with different lenses** — same activity types, same grain, and after
the 8/24 loosening the *only* difference in their activity rules is one option value: SAMA acceptance
counts for TC and not for SBSH. Everything else is the company lens. That is the canonical-model premise
holding up, and it is the reason a lens-driven engine is the right shape.

**Every lens is now a pure company-attribute predicate.** No grant's lens has to walk the activity
graph to decide eligibility — enrollment dropped out of both TC and SBSH on 8/24. Cheaper to evaluate,
far easier to explain in an audit, and it maps one-to-one onto the three-filter model in
`report-engine-design.md`.

**No grant gates on D5 (business type), and none gates directly on D6** — both show up implicitly
through NAICS. Given D6 is only 18% knowable, that is fortunate today and a risk for grant #5.

---

## 7. What is needed to call these final

Resolved on 8/24: TC's program interaction (loosened — no enrollment gate) · SBSH's LOCAL requirement
(removed from the lens) · Gateway's age criterion (added, < 10 years) · i4.0's position in the queue
(last, separate system) · and the standing guidance that **historical coverage is not a gate**.

**Still needed from Zach — 10 confirmations,** roughly in order of how much each moves:

1. **D2's definition** — HUBZone/OZ as we evaluate it, or the template's CDFI-tract / QCT / rural-MI-county? Half of SBSH's gate.
2. **TC `small_business()`** — evaluate the SBA size standard, or document an assumption?
3. **Grant periods** — start/end per grant (only SBSH's start is evidenced, 2023-12-18), plus the effective date Lenawee drops.
4. **Gateway snapshot tie-break** — a company with two metrics snapshots in one period: latest, or nearest the period end?
5. **Gateway age** — as at period end or activity date, and incorporation vs Michigan registration?
6. **Gateway "created"** — what makes a company Hub-created?
7. **`LOCAL` granularity** — does every `local` acceptance count, or only the Fellows Bootcamp? And do `intake` / `grant` qualify for SBSH?
8. **Derivation maps** — TC col O (networking/mentorship) and col Q (Other); SBSH col AC; i4.0 service-type and status. Plus: build i4.0 tab 2's classifier, or drop the tab?
9. **Bare-contact subjects (§1)** — approach **A** (enrich contacts) or **B** (create a light company at first service)? And does the bare-contact path apply to Gateway/i4.0, or only TC and SBSH?
10. **TC event grain** — one row per attending business per event, or attendees only into KPI 3?

**From the system — 4 gaps that block a definition rather than a column.** These are not about
historical coverage; they are fields the ingestion path is not writing at all, so they would stay empty
however good future collection gets:

- **Metrics activities: 0 records** — no snapshot is being captured, and each new form submission
  overwrites the last on the contact. Blocks Gateway almost entirely. Wire webhook #3, then backfill.
- **`modality`: 0/13** — blocks TC required KPIs 7 and 8. Pure config; `activity_routes.defaults` already works.
- **`workshop_event`: 0 records** — blocks TC required KPI 3. Phase 6.
- **Grant headline fields: 0/63** — blocks TC KPI 1 and SBSH `Total Dollars Deployed`.

Detail and fixes: `funder-field-trace.md` §6.
