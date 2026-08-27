# Funder-template field trace — gate (3) of the readiness bar

> **What this is.** Every column of every active funder template, traced to the **specific GHL field
> or aggregate** behind it. `REPORTING_TEMPLATES_ANALYSIS.md` inventoried the columns and classified
> them (Activity / Company / Outcome / Computed); this doc names the field, and says whether that
> field actually holds data.
>
> **Written 2026-08-21.** Field catalogs and population are **measured against live**, not assumed:
> `npx vite-node scripts-ts/dump-catalogs-full.ts` → `reports/catalog-dump-full.json`
> `npx vite-node scripts-ts/report-readiness-census.ts` → `reports/report-readiness-census.json`
> Re-run both to see the gaps close. Templates: `../../../Past Grant Reports/` (22 submissions).

## How to read the status column

| | Meaning |
|---|---|
| ✅ | Field exists **and** is populated well enough to report on. |
| 🟡 | Field exists; population is thin (the % is measured) — a gate-(4) problem, not a build problem. |
| 🔴 | Field exists but is **empty where it matters**, or the value lands somewhere the report can't read. Needs code. |
| ⬜ | **No field exists.** Needs a GHL field, or a decision to source it outside the system. |
| 🧮 | Computed at report time from atomic facts. No stored field, by design. |
| 🙋 | A **derivation decision for Zach** — the data exists but which column it feeds is a policy call. |

Denominators: **897 companies**, **1,535 contacts** (1,086 linked to a company), **234 activities**.

---

## 0. Headline — what the trace found

The **schema traces almost completely**. Of ~150 template columns, only 7 have no field anywhere.
What the trace actually exposed is that **three of the four report-critical activity families are
empty or unusable on live**, so most columns trace to a real field that has no data in it:

| Activity type | Records | Consequence for reporting |
|---|---|---|
| program_acceptance | 84 | ✅ enrollment intervals are there — the eligibility lens has its input |
| intake | 73 | ✅ TC/SBSH intake columns and "date of initial intake" are derivable |
| grant | 63 | 🔴 `award_amount`, `award_date`, `grant_program`, `grant_reason` are **0/63** |
| technical_assistance | 13 | 🔴 `modality` and `service_topic` are **0/13** — TC's two required TA KPIs can't be computed |
| introduction_referral | 1 | 🔴 one test record; every referral column across TC + SBSH is empty |
| workshop_event | **0** | 🔴 phase 6 not built — TC KPI 3 (required) has no source |
| metrics | **0** | 🔴 **every outcome column on Gateway, SBSH and TC KPIs 12–15 traces here** |

**The metrics hole is the big one, and it is actively getting worse.** The Client Reporting form
writes to CONTACT fields, and each submission **overwrites the previous one** — so prior-period
snapshots are being destroyed right now, exactly the way pipeline history was before webhook #1 went
in. Every outcome number Gateway asks for (jobs, products, the 8-way follow-on-funding split) and
most of what SBSH asks for lives only in the latest answer on the contact.

One correction to `REPORTING_TEMPLATES_ANALYSIS.md`: it lists TC KPIs 12 and 13 (*jobs created / retained
by companies served*) as "not derivable → separate internal sourcing." They **are** derivable —
`metrics.jobs_created_in_the_last_6_months` / `…jobs_retained…` exist on the activity object. Only
KPIs 9–11 (LRL's *own* org jobs and staff PD) are genuinely outside the system.

---

## 1. The shared company block

The left-hand columns of all four templates. Sourced from `business` except where noted.

| Template column(s) | GHL field | Pop. | Status |
|---|---|---|---|
| `ID#` (TC A, SBSH A) | row counter in the generated sheet | — | 🧮 |
| `Organization` (GW, i4.0 col A) | literal `"Lean Rocket Lab"` | — | 🧮 |
| Business / Company Name | `business.name` | 100% | ✅ |
| Street Address / Address | `business.address` | 84% | 🟡 **69 rows hold the literal string `"undefined"`** → true coverage 76% |
| City | `business.city` | 89% | 🟡 |
| ST / State | `business.state` | 90% | 🔴 **27 distinct spellings** — MI appears as `MI` (626), `Michigan` (145), `Mi` (8), `mi` (1). Normalize at report time; every grant filters on Michigan |
| Zip Code | `business.postalcode` | 81% | 🟡 3 values aren't a 5/9-digit zip |
| County (TC G, SBSH G) | `business.county` `[AI]` | 82% | ✅ full 83-county MI list, enriched |
| Business Owner's Name | linked contact `firstName` + `lastName` | 99% | ✅ |
| Email | linked contact `email` | 99% | ✅ |
| Phone Number (GW, i4.0) | linked contact `phone` | 57% | 🟡 **`business.phone` is 0/897** — always read the contact |
| Company Website | `business.website` | 61% | 🟡 |
| NAICS (SBSH J, GW, i4.0) | `business.naics_code` `[AI]` | 74% | 🟡 Gateway constrains it to **31 allowed 4-digit codes** — the engine must validate membership, not just presence |
| LARA ID (SBSH K **required unique key**, GW Companies-Created) | `business.lara_id` `[AI]` | **31%** | 🟡 the designated dedup key is present on under a third of companies |
| Date Registered in LARA (SBSH L) | `business.date_registered_in_michigan` | 27% | 🟡 |
| Date Established (SBSH P) | `business.date_of_incorporation` | 28% | 🟡 |
| Current FTEs (SBSH N) | `business.fte_current` — or `metrics.current_number_of_full_time_equivalents_fte` for a per-period figure | 36% | 🟡 |
| Projected FTEs (SBSH O) | `business.fte_hiring_next_12mo` / `metrics.new_jobs_projected` | 36% | 🟡 |
| Annual Revenue > $1M (SBSH Q, Yes/No) | 🧮 from `business.annual_revenue` (31%) or `business.revenue_stage='Greater than $1,000,000'` (15%) | — | 🧮 |
| Minority / Women / Veteran / Disabled Owned (SBSH S–V, TC J minority only) | `business.minority_owned`, `.women_owned`, `.veteran_owned`, `.disabled_owned` — all `{True\|False}` | 39% each | 🟡 |
| **Decline to Answer** (SBSH R) | — | — | ⬜ no field |
| **Tribal** (SBSH M) | — | — | ⬜ no field (replaces EIN/TIN per SBSH definitions) |
| **DUNS** (i4.0) | — | — | ⬜ no field (optional column) |
| Business Description (SBSH Success tabs) | `business.description` | high | ✅ |

### The geo-disadvantaged qualifier — the one place the model answers the wrong question

TC col K and SBSH col W share a dropdown: **SEDI-owned / Geographic Area defined in Grant Agreement /
Disproportionate negative economic impact as a result of COVID**.

- `business.geo_disadvantaged` `[AI]` (77% populated) holds **`HUBZone` / `Opportunity Zone` / `None`** —
  a different classification. Useful evidence, not the answer to this column.
- The right-shaped field exists only on the **contact**:
  `contact.how_was_the_business_impacted_by_covid` → `{SEDI-Owned | Geographic Area defined in Grant
  Agreement | No}` — and it is **missing the third option**, so a COVID-impact determination has
  nowhere to go. Its rationale field is `contact.description_how_was_determination_made_for_how_
  business_was_impacted_by_covid` (SBSH col X), plus a free-text
  `contact.geographically_disadvantaged_business_location`.
- SBSH's own definition of the geographic area is **2015 CDFI Investment Tract, 2020 Qualified Census
  Tract, or a Rural Michigan county** — which the HUBZone/OZ enricher does not evaluate.

**Status: 🔴 + ⬜.** Blocks TC col K, TC KPI 2 (*required*, target 100) and SBSH col W. Fix in §6.

---

## 2. Trusted Connector — row sheet (one row per service event)

| Col | Template column | Traces to | Status |
|---|---|---|---|
| B–I | Business info | §1 | 🟡 |
| J | Minority Owned or Controlled | `business.minority_owned` | 🟡 39% |
| K | Geographically Disadvantaged? | see §1 | 🔴 |
| L | 1:1 Technical Assistance | `activity_type='Technical Assistance'` **AND `modality='1:1'`** | 🔴 `modality` 0/13 |
| M | Group Technical Assistance | same, `modality='Group'` | 🔴 |
| N | Hosted a Tech or Innovation event | `activity_type='Workshop / Event'` AND `event_type='Tech/Innovation Event'` | 🔴 0 records |
| O | Networking or mentorship initiative | candidates: `event_type ∈ {Roundtable, Other}`, or `referral_type='Mentor'` | 🙋 decision |
| P | Referral | `activity_type='Introduction / Referral'` | 🔴 1 record |
| Q | Other | `service_topic='Other'`, or an activity matching no other column | 🙋 decision |
| R | Direct Grant ($) | `award_amount` — **0/63**. The populated field is `score_total_grant_amount` (54/63) | 🔴 |
| S | Date Direct Grant Awarded | `award_date` — **0/63**. De facto: `activity_date` (63/63) + `grant_status='Agreement Executed'` (61/63) | 🔴 |
| T | Reason for grant | `grant_reason` — **0/63**. Detail that *did* land: `expense_category_item_1..10` + `expense_description_item_1..10` (~52/63 each) | 🔴 |
| U | **Facilitated Revenue from Grant funding** | — | ⬜ no field anywhere |
| V–W | Capital Provider Referral + name | `referral_type='Capital Provider'` + `counterparty_name` | 🔴 no data |
| X–Y | **SB Ecosystem Partner Referral** + name | `referral_type` has **no such option** `{Mentor\|Other SBSH\|MI-SBDC\|SmartZone\|Capital Provider\|Other}` | ⬜ option missing |
| Z–AA | Other (Name) | `referral_type='Other'` + `counterparty_name` | 🔴 no data |
| AB | Reason for Referral | `referral_reason` | 🔴 no data |
| AC–AD | `__` / Duplicate helpers | dedup columns the generator fills | 🧮 |
| AE | Notes | `activity_notes` | ✅ |

### TC KPI / Smartsheet sheet

| # | KPI | Required | Derivation | Status |
|---|---|---|---|---|
| 1 | # grants made to small businesses | no | `COUNT(activity_type='Grant' AND grant_program='Trusted Connector' AND date ∈ period)` | 🔴 `grant_program` 0/63 — a grant can't be attributed to a budget |
| 2 | # businesses in Geo Disadvantaged Area | **yes** | `COUNT DISTINCT company` where the §1 qualifier is set and served in period | 🔴 |
| 3 | # attendees at tech & innovation events | **yes** | `SUM(workshop_event WHERE attended='Yes' AND event_type='Tech/Innovation Event')` | 🔴 phase 6 |
| 4 | # Minority Owned Businesses Served | no | `COUNT DISTINCT company WHERE minority_owned=True` served in period | 🟡 39% |
| 5 | # total businesses served | **yes** | `COUNT DISTINCT company` with ≥1 activity in period | ✅ **computable today** |
| 6 | # networking / mentorship initiatives executed | **yes** | depends on col O + phase 6 | 🙋 |
| 7 | # businesses supported 1:1 | **yes** | `COUNT DISTINCT company` where TA + `modality='1:1'` | 🔴 |
| 8 | # businesses via small-group TA | **yes** | same, `modality='Group'` | 🔴 |
| 9 | # staff professional development sessions | no | LRL's own org | 🙋 manual, by design |
| 10–11 | jobs created / retained **within LRL** | no | LRL's own org | 🙋 manual, by design |
| 12 | Jobs Created by Companies Served | no | `SUM(metrics.jobs_created_in_the_last_6_months)` | 🔴 0 metrics records — **but derivable**, contra the old analysis |
| 13 | jobs retained by companies served | no | `SUM(metrics.jobs_retained_in_the_last_6_months)` | 🔴 same |
| 14 | Facilitated capital access | **yes** | `COUNT DISTINCT company` with any `metrics` FOF field > 0 in period | 🔴 0 metrics records |
| 15 | Facilitated revenue re: direct grants | no | col U | ⬜ |
| 16 | # Referrals to SB Ecosystem Partners | **yes** | `referral_type='Ecosystem Partner'` | ⬜ option missing |

**5 of TC's 8 required KPIs cannot be produced today.** Only #5 is ready as-is.

---

## 3. SBSH — quarterly template

### SB Data tabs (one row per event; LARA ID dedupes)

| Col | Template column | Traces to | Status |
|---|---|---|---|
| A–I | ID# + business info | §1 | 🟡 |
| J–M | NAICS / LARA ID / Date Registered / **Tribal** | §1 | 🟡 / ⬜ |
| N–Q | Current & Projected FTEs, Date Established, Revenue>$1M | §1 | 🟡 |
| R–V | Decline to Answer + 4 demographic flags | §1 | ⬜ / 🟡 |
| W–X | COVID impact + how determined | §1 (contact-side, option missing) | 🔴 |
| Y | Date of Initial Intake (≥ 12/18/23) | `business.date_of_initial_intake` is **0/897** → use `MIN(activity_date WHERE type='Intake')`, 73 records | 🧮 prefer computed |
| Z | First Time Served by the Hub | 🧮 no activity for this company in the prior 18 months. (`business.supported_by_lrl_18mo`, 38%, is self-reported — evidence, not the answer) | 🧮 |
| AA | 1:1 Business Consulting | TA + `modality='1:1'` | 🔴 |
| AB | Group Training | TA + `modality='Group'`, or `workshop_event` | 🔴 |
| AC | Small Business Support Services | `service_topic ∈ {?}` | 🙋 decision |
| AD | Other | — | 🙋 |
| AE–AF | Direct Grant (≤$20k) + date | as TC R/S | 🔴 |
| AG | Follow on Funding | `metrics.score_client_total_follow_on_funding`, or the sum of the 8 source fields | 🔴 0 records |
| AH | **Date of Follow on Funding** | only `metrics.reporting_period` (the half-year window) exists | ⬜ no date field |
| AI–AJ | Mentor + name | `referral_type='Mentor'` + `counterparty_name` | 🔴 no data |
| AK–AL | Other SBSH + name | `referral_type='Other SBSH'` | 🔴 |
| AM–AN | MI-SBDC + name | `referral_type='MI-SBDC'` | 🔴 |
| AO–AP | SmartZone + name | `referral_type='SmartZone'` | 🔴 |
| AQ–AR | Other + name | `referral_type='Other'` | 🔴 |
| AS | Reason for Referral | `referral_reason` | 🔴 |
| AT–AU | `__` / Duplicate | generator | 🧮 |
| AV | Notes | `activity_notes` | ✅ |

### Reporting Datafields (all computed; the classification rules are in the template's Definitions tab)

| Datafield | Derivation | Status |
|---|---|---|
| Pre-business ideation | `business.where_are_you_today = 'I have an idea, no product or customers yet'` | 🙋 confirm this is the intended proxy |
| New Business Starts | created via the Hub, < 12 months: `date_of_incorporation ∈ period` AND an intake before it | 🙋 |
| Early Stage Businesses Served | `date_of_incorporation` 1–3 years old | 🧮 (28% pop.) |
| Microbusinesses Served | `fte_current < 10` | 🧮 (36% pop.) |
| Second Stage Businesses Served | `fte_current ≥ 10` **AND** `annual_revenue ≥ 1,000,000` | 🧮 |
| **Total Unique Businesses Served** | `COUNT DISTINCT company` with ≥1 activity in quarter | ✅ ready |
| Current Full Time Employees | `SUM(fte_current)` over served companies | 🧮 |
| Projected New Full Time Jobs | `SUM(fte_hiring_next_12mo)` / `metrics.new_jobs_projected` | 🧮 |
| Total Dollars Deployed (Direct Grants) | `SUM` of grant amount | 🔴 field split (§6.3) |
| Total Follow on Funding | `SUM` of the metrics FOF fields, **excluding SBSH grants** | 🔴 0 records + missing bank/loan |
| Minority / Women / Veteran / Disabled counts + % minority | `COUNT` over `business.*_owned` | 🟡 39% |
| Businesses served 1st time by the Hub | col Z rule | 🧮 |
| Mentorship Connections Made | `COUNT(referral_type='Mentor')` | 🔴 |
| Referrals to other SBSH / MI-SBDC | `COUNT(referral_type='Other SBSH' / 'MI-SBDC')` | 🔴 |
| Businesses receiving programming from a SmartZone | `COUNT(referral_type='SmartZone')` | 🔴 |
| **Referrals to Ecosystem Partners** (outside the SBSH network) | `referral_type='Ecosystem Partner'` | ⬜ option missing |
| General Project Info / Financial Obligations / Demographic Distribution | template says "Enter into Salesforce — not required for this form" | 🙋 out of scope |

Success tabs (narrative, one company per quarter) = `business.description` + `business.problem_you_solve`,
`.target_customer`, `.why_started_business`, plus `metrics.what_is_the_most_exciting_thing_that_has_
happened_with_your_company_in_the_last_6_months`. Prompt-driven prose, assembled not computed.

---

## 4. Gateway / SmartZone — one row per **company**

Selection gate: Michigan + a NAICS in the template's 31-code high-tech/manufacturing list.

| Template column | Traces to | Status |
|---|---|---|
| Organization / Company Name / Address / City / State / Zipcode | §1 | 🟡 |
| NAICS (dropdown, 31 codes) | `business.naics_code` — must be **in the list** | 🟡 |
| Contact First / Last Name, Email Address | linked contact | ✅ 99% |
| Company Website | `business.website` | 🟡 61% |
| Phone Number | linked contact `phone` | 🟡 57% |
| Commercialized Products | `metrics.number_of_new_products_commercialized_in_the_last_6_months` | 🔴 0 records |
| Products in the Commercialization Pipeline | `metrics.number_of_products_in_the_commercialization_pipeline` | 🔴 |
| Jobs Created | `metrics.jobs_created_in_the_last_6_months` | 🔴 |
| Jobs Retained | `metrics.jobs_retained_in_the_last_6_months` | 🔴 |
| MEDC Funds Awarded | `metrics.medc_funding_received_in_the_last_6_months` | 🔴 |
| SBIR, STTR & Other Federal | `metrics.federal_funding_including_sbir_and_sttr_received_in_the_last_6_months` | 🔴 |
| Venture Capital | `metrics.venture_capital_funding_received_in_the_last_6_months` | 🔴 |
| Angel Funds | `metrics.angle_investor_funding_received_in_the_last_6_months` *(sic — "angle")* | 🔴 |
| **Bank/Loan** | `contact.bank_loans_received_in_the_last_6_months` exists — **no activity twin, so ingestion drops it** | ⬜ field missing on the object |
| Owner Investment | `metrics.owner_investment_in_the_last_6_months` | 🔴 |
| New Sales (Increase in Revenue) | `metrics.new_sales_in_the_last_6_months` | 🔴 |
| Other + Other Explanation | `metrics.other_funding_received_in_the_last_6_months` + `.describe_other_funding_received` | 🔴 |
| `Companies Created` tab | same schema + `business.lara_id` | 🟡 31% |
| `Non-served reporting FOF` tab | same schema; selection = FOF > 0 **and no activity in the period** | 🧮 |

Gateway also has IP columns in the wider MEDC family, and the activity object already carries them:
`number_of_patents_applied_for…` / `…issued…`, `…trademarks…`, `…copyrights…`,
`number_of_licensing_agreements_signed_in_the_last_6_months` (+ `…with_michigan_based_companies`),
`number_of_option_agreements…`. The **non-MI** licensing count exists on the contact
(`number_of_license_agreements_made_with_nonmi_vendors_in_the_last_6_months`) with no activity twin —
derive it as total − MI, or add the field.

---

## 5. Industry 4.0 Accelerator — one row per **event**

Tab split: `Small MI Manufacturers Served` = Michigan + manufacturing NAICS (31xx–33xx);
`Other Companies Served` = everyone else, including out-of-state tech vendors. This is the only grant
that legitimately reports out-of-state entities.

| Template column | Traces to | Status |
|---|---|---|
| Organization / Company Name / Address / City / State / Zipcode / Website | §1 | 🟡 |
| Contact First / Last Name / Email | linked contact | ✅ |
| Phone Number | linked contact `phone` | 🟡 57% |
| NAICS Code | `business.naics_code` | 🟡 74% |
| **DUNS (if available)** | — | ⬜ no field |
| Date of Service | `activity_date` | ✅ |
| Type of Service provided (8-option dropdown) | derive from `activity_type` + `event_type` + `service_topic`: Initial survey←Intake · Referral←Introduction/Referral · Webinar/Seminar ← `event_type='Webinar'` · Roundtable ← `event_type='Roundtable'` · Events ← other `workshop_event` · Business Analysis / Demo project ← `service_topic`? | 🙋 confirm the map |
| If "other" selected please explain | `activity_notes` | ✅ |
| Status (New / In Progress / Completed / On Hold / Cancelled) | derive from `appointment_status` `{confirmed, showed, noshow, cancelled, invalid, new}` — Completed←showed, Cancelled←cancelled/noshow, New←confirmed? | 🙋 confirm the map |
| Comments | `activity_notes` | ✅ |
| Budget tab — `Number of Companies Served` | `COUNT DISTINCT company` in period | ✅ |
| Budget tab — spend lines | LRL's own finance | 🙋 manual |

---

## 6. Gap register — ordered by blast radius

### 6.1 🔴 Metrics activities: 0 records — **and history is being destroyed while this is open**
Blocks: Gateway's entire outcome half (11 columns), SBSH `Total Follow on Funding` / FTE / dollars /
job counts, TC KPIs 12–15. The Client Reporting form writes to contact fields where each submission
**overwrites the last**, so every period that passes without ingestion loses a snapshot permanently —
the same failure mode as the pre-webhook pipeline history.
**Fix:** wire GHL webhook #3 (Client Reporting → `/api/form-sync`, body in `PROJECT_STATE.md` ⭐),
then backfill with `scripts-ts/form-ingest-run.ts metrics --apply` exactly as the grant detail was
filled on 8/19. The backfill recovers **one** snapshot per client (whatever the contact currently
holds), not the history already overwritten.

### 6.2 🔴 `modality` + `service_topic` empty on all 13 TA activities — **but this is config, not code**
Blocks TC cols L/M and **TC required KPIs 7 and 8**, SBSH cols AA/AB.
**The engine already supports the fix.** `activity_routes.defaults` (jsonb) exists, and the
appointment adapter already applies it — `modalityFor(route)` reads `route.defaults.modality`
(`lib/activities/sources/appointment.ts:81`) and every default is spread onto the record
(`:157`). The three TA routes simply have no `defaults` set:

| Calendar | Route | `defaults` today |
|---|---|---|
| SAMA Coaching | technical_assistance | — |
| SAMA Coaching Call | technical_assistance | — |
| Sales and Marketing Accelerator Check-In | technical_assistance | — |

**Fix:** decide the modality + topic per calendar (a coaching call is `1:1` + `Coaching`; a cohort
calendar would be `Group`) and set them. The only code needed is a `--default k=v` flag on
`scripts-ts/activity-routes.ts`, which today accepts `--type` and `--program` but has no way to write
`defaults`. Per the Sprint C design, `service_topic` is ultimately meant to come from the Zoom AI
Companion summary; a route default is the correct interim value, not a workaround.

### 6.3 🔴 Grant amount / date / program / reason empty on all 63 grant activities
The form-ingest key-match copied the expense line items but not the headline fields, because the
contact keys differ from the activity keys:
- `contact.direct_grant_program` → activity `grant_program` (no twin → dropped). Without it a grant
  can't be attributed to the TC vs SBSH budget, which is TC KPI 1 and SBSH `Total Dollars Deployed`.
- amount: `score_total_grant_amount` is populated (54/63); `award_amount` is the field the reports
  should read. Pick one and map to it.
- `award_date`: derive from the pipeline transition into `Agreement Executed`.
- `grant_reason`: assemble from `expense_description_item_1..10`, or map the application's narrative
  (`contact.please_do_into_detail_on_how_you_will_specifically_utilize_the_funds…`).
- 🐞 **`contact.expense_category_item3`** is missing its underscore, so item-3's category never
  copies while items 1–2 and 4–10 do. One-character field-key bug.

### 6.4 🔴 `workshop_event`: 0 records — phase 6
Blocks TC col N + **required KPI 3** (attendees at tech/innovation events, target 100) and KPI 6, and
SBSH `Group Training`. **Phase 6 (Wix attendance) is therefore a Sprint C dependency, not just the
tail of Sprint B** — TC cannot be regenerated without it.

### 6.5 🔴/⬜ The geo-disadvantaged qualifier answers the wrong question, on the wrong object
See §1. Blocks TC col K + **required KPI 2** and SBSH col W.
**Fix:** add the 3-option qualifier + rationale to `business` (the report reads companies), append the
missing `Disproportionate negative economic impact as a result of COVID` option to the existing
contact field, and map contact→company in the `contact-to-company` connection. Keep
`business.geo_disadvantaged` (HUBZone/OZ) as separate supporting evidence, and note SBSH's own
definition needs CDFI-tract / QCT / rural-county evaluation that the current enricher doesn't do.

### 6.6 ⬜ `referral_type` has no `Ecosystem Partner` option
Blocks TC cols X/Y + **required KPI 16** and SBSH `Referrals to Ecosystem Partners`.
**Fix:** append the option with `scripts-ts/add-field-options.ts` — read → append → write → read back.
A picklist write REPLACES the whole list, so a dropped option orphans every record holding it.

### 6.7 ⬜ Seven columns with no field anywhere
| Column | Grant | Note |
|---|---|---|
| Facilitated Revenue from Grant funding | TC U + KPI 15 | LRL confirms downstream revenue; needs a field and an owner |
| Tribal | SBSH M | replaces EIN/TIN in the SBSH definitions |
| Decline to Answer | SBSH R | the 5th demographic response |
| Date of Follow on Funding | SBSH AH | only the half-year `reporting_period` exists |
| Bank/Loan FOF | Gateway | the contact field exists; the **activity** field doesn't, so it's dropped at ingestion |
| Non-MI licensing agreements | MEDC IP | or derive as total − MI |
| DUNS | i4.0 | optional column |

### 6.8 🟡 Population (gate 4) — the thin fields that matter
`lara_id` 31% (SBSH's *required unique key*), the four demographic flags 39%, `fte_current` 36%,
`annual_revenue` 31%, `date_of_incorporation` 28% — and SBSH's whole business-stage classification is
computed from the last three, so its Reporting Datafields inherit the worst of them.

### 6.9 🟡 Hygiene that bites at report time
27 spellings of `state` · 69 addresses holding the literal string `"undefined"` ·
`business.date_of_initial_intake` 0/897 (derive from intake activities instead) ·
3 malformed zips · `business.phone`/`business.email` 0/897 (always read the contact).

### 6.10 🙋 Derivation decisions for Zach
1. TC col O — what counts as a "networking or mentorship initiative"?
2. TC col Q "Other" and SBSH col AC "Small Business Support Services" — which `service_topic` values?
3. i4.0 `Type of Service provided` — confirm the 8-way map in §5.
4. i4.0 `Status` — confirm the `appointment_status` → status map in §5.
5. SBSH `Pre-business ideation` — is `business.where_are_you_today` option 1 the intended proxy?
6. SBSH `New Business Starts` — what makes a start "created via the Hub"?
7. Grant amount — is `score_total_grant_amount` or `award_amount` the field of record?

---

## 7. What this means for Sprint C

Gate (3) is now **traced**: every column has a named source or a named gap. The engine can be built
against this table. But the trace changes the order of what comes first:

1. **Sprint C's acceptance test is unreachable until §6.1–6.5 land.** "Regenerate a real submitted TC
   sheet and match it" needs TA modality, grant headline fields, event attendance and the geo
   qualifier — 5 of TC's 8 required KPIs are blocked on them. These are small, targeted fixes
   (a route config field, a form field map, an option append, a field add), not a sprint.
2. **§6.1 is time-sensitive** for the same reason webhook #1 was: unwritten metrics history is being
   overwritten on the contact as clients submit.
3. **Phase 6 is promoted.** It is no longer "the tail of Sprint B" — it is TC required KPI 3.
4. **Gate (4) is now measured, not unknown** (`reports/report-readiness-census.json`). The population
   picture is: identity + geography good (74–100%), demographics and firmographics thin (28–39%),
   outcomes absent (0%). Reports over the recent, profiled cohort are viable; reports over the whole
   897 are not, and no amount of engine work changes that — only intake coverage does.
