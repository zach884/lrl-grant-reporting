# Sprint A — Client Stage Scoring Enricher (kickoff + raw material)

> Purpose: rebuild the brittle GHL "MRL/TRL/CRL/Churchill" scoring workflow as an **app
> enricher** that appends a **new record per scoring event** to the live `custom_objects.business_stage`
> ("Client Stage Tracking") object, associated to the company — giving a per-company scoring
> **history** instead of the current single overwritten contact value.
>
> **Company-centric (Zach, 2026-07-28):** the scorer reads its inputs from the **COMPANY** record,
> not the contact. Data flow = contact fills forms → up-sync pushes those answers up to the Company
> → the Company record is the authoritative scoring input → the enricher scores the company and
> writes a stage record associated to it. The enricher is therefore **company-scoped** (one score
> run per company), even though the triggering event is a contact form/change.
>
> This file holds the verbatim GHL prompts + field/output mapping + open questions. It is the
> source material for the Claude Code sprint. Prompts pasted by Zach 2026-07-28.

## Confirmed live state (checked 2026-07-28, prod loc `FgnVVv4smxyBNJKFZgJv`)
- Object `custom_objects.business_stage` ("Client Stage Tracking") is **LIVE**. Fields (12):
  `name`, `rescore_date` (DATE), `rescore_method` (SINGLE_OPTIONS), `churchill_substage` (TEXT),
  `churchill_score` (NUMERICAL), `trl` (NUMERICAL), `mrl` (NUMERICAL), `crl` (NUMERICAL),
  `total_business_stage_advancement` (NUMERICAL), `stage_rationale` (LARGE_TEXT),
  `source_contact_id` (TEXT), `snapshot_kind` (SINGLE_OPTIONS).
- Association `company_business_stage` (business ↔ custom_objects.business_stage) is **LIVE**.
- **0 records** exist → the history backfill has NOT been applied to live yet.

## What already exists in the app (reuse, don't rebuild)
- `lib/ai/anthropic.ts` — Claude client; existing AI enrichers `readinessTagger`, `naics` show the pattern.
- `scripts-ts/backfill-client-stage.ts` + `lib/stage/parseStageNotes.ts` — one-time history backfill
  (mines old "Stage Scoring" notes + `*_current`/`*_initial` contact fields → creates stage records,
  idempotent on `source_contact_id + rescore_date`). Run against live to seed history.
- `lib/enrichment/recordEngine.ts` / `lib/ghl/records.ts` / `lib/ghl/writeRecord.ts` — object-record
  read/write plumbing. NOTE: recordEngine *fills fields on an existing record*; the scorer instead
  **creates a new record per run** (like the backfill), so it needs the record-create path, not the
  fill-empty policy engine.
- `lib/enrichment/types.ts` — Enricher/Provenance interface (`method: 'ai'`, confidence, rationale).

## EFFICIENCY: collapse the 7 GHL calls into ONE structured call (Zach, 2026-07-28 — keep it cheap)
The 7 separate prompts are a GHL artifact (GHL forces one prompt per output field). In code, **make it
a single Claude call** that returns one JSON object with all outputs:
`{ trl, mrl, crl, churchill_stage, churchill_substage, tech_rationale, service_rationale }`.
One prompt carries all rubrics + all Company inputs; the model computes the scores, then the sub-stage
(N/A unless stage=3), then both rationale notes — in one pass. ~7× fewer calls/tokens per scoring event.
The **re-score** variant is the SAME prompt with an optional "Previous assessment" block (prior scores +
prior rationale); when present, instruct the rationale fields to describe what changed vs. stayed. Keep
the rubric text and per-dimension "primary signal" guidance verbatim from the prompts below — only the
plumbing (7 calls → 1 JSON call) changes. Validate the consolidated call against the old per-field
scores on a sample (see acceptance) before trusting it; consider a cheaper model tier if quality holds.

## The scoring model (logically 7 outputs, physically 1 call)
Two variants: **initial** (no prior record) and **re-score** (a prior record exists → feed prior
scores + prior rationale back in). Within the single call: classifiers are independent; sub-stage
depends on Churchill stage; rationales depend on all scores (and, on re-score, the prior record).

| Call | Output | Object field |
|---|---|---|
| TRL classifier | integer 1–9 | `trl` |
| MRL classifier | integer 1–10 | `mrl` |
| CRL classifier | integer 1–9 | `crl` |
| Churchill stage classifier | integer 1–5 | `churchill_score` |
| Churchill sub-stage | `III-D` / `III-G` / `N/A` (only if stage=3) | `churchill_substage` |
| Tech-path rationale (TRL/MRL/CRL) | formatted note | → part of `stage_rationale` |
| Service-path rationale (Churchill) | formatted note | → part of `stage_rationale` |

- `stage_rationale` = the tech-path note + service-path note joined (backfill joins with `\n\n---\n\n`).
- `rescore_method` = `AI` (leave room for `Staff` / `AI+Override`).
- `snapshot_kind` = `initial` vs `rescore` (mirror the two variants).
- `source_contact_id` = the triggering contact. `rescore_date` = now.

## Input source — read from the COMPANY record (Zach, 2026-07-28)
The prompts below reference `{{contact.*}}` (legacy workflow). In the new enricher, **remap each of
those to the Company-side field** and read values from the Company record. Contacts fill forms → the
existing up-sync (`lib/sync`, `config/field-mappings.json`) carries those answers up to the Company →
the enricher scores off the Company. The contact→company key pairs for most of these 19 fields already
exist in `config/field-mappings.json`; derive the `business.*` keys from there and confirm each exists
on the `business` object catalog (add any missing company fields — same idempotent script pattern used
for the other company fields).

## Memory source (the key architectural change)
The old workflow reads "previous scores + rationale" from the **contact** fields
(`trl_current`, `mrl_current`, `crl_current`, `churchill_current`, `churchill_substage_current`,
`latest_tech_stage_rationale`, `latest_churchill_stage_rationale`). The new enricher should read
"previous" from the **latest `custom_objects.business_stage` record for the company** (via the
`company_business_stage` association), falling back to the contact `*_current` fields only if no
record exists yet (i.e. before the backfill runs).

## The 19 scoring input fields (contact keys shown; remap to `business.*`)
`company_description`, `where_are_you_today`, `current_state_of_your_technology_product`, `patents`,
`independent_validation`, `how_is_your_product_manufactured_today`, `manufacturing_partner_status`,
`annual_revenue`, `revenue_stage`, `number_of_paying_customers_today`, `where_you_are_with_selling`,
`have_you_found_product_market_fit`, `date_of_incorporation`, `number_of_full_time_equivalents_fte`,
`number_of_fte_you_anticipate_hiring_in_the_next_12_months`, `owner_involvement`, `cash_flow_today`,
`locations_sites_of_operation`, `management_team`.

## OPEN QUESTIONS (resolve before/while building)
1. **`total_business_stage_advancement`** — DEFERRED (Zach 2026-07-28; not needed for the migration).
   Definition: a **cumulative count of stages advanced** = sum of the per-field deltas (new − previous
   for trl/mrl/crl/churchill) added to the prior record's total. Not model-produced; computed at write
   time from the prior record. Leave it null/unwritten for now; wire it later for "how many stages have
   we helped companies advance" reporting.
2. **Tech-path vs service-path routing** — do all clients get all 4 scores, or does a field branch
   them (tech → TRL/MRL/CRL, service → Churchill)? What field decides? Does a client get one rationale
   or both? (Object has a single `stage_rationale`; backfill concatenates both.)
3. **Model provider** — GHL uses OpenAI ("chatgpt" steps); app AI enrichers use Claude. Porting to
   Claude is consistent but can shift calibration → acceptance test = compare new scorer vs the live
   workflow's scores on a sample of already-scored clients.
4. **Trigger** — which of the 19 input fields changing should re-enroll. Flow is form → up-sync to
   Company → score; so the trigger is "the Company's scoring inputs changed" (fed by the existing
   `Contact Changed` up-sync webhook), plus an on-demand/batch runner (works before the webhook is
   deployed, and to score the existing client base).
5. **Company-side field coverage** — confirm all 19 inputs exist on the `business` object (derive keys
   from `config/field-mappings.json`; add any missing via the idempotent field-setup script). Some are
   free-text/narrative (`where_are_you_today`, `current_state_of_your_technology_product`) that may not
   have been mapped up yet — verify they carry up cleanly.

---

# VERBATIM PROMPTS (as pasted from the GHL workflow)

## INITIAL SCORING

### TRL
```
You are a Technology Readiness Level (TRL) classifier for Lean Rocket Lab, a Michigan-based startup incubator. Your task is to assign a TRL score (1-9) to a client based on their intake form responses.
TRL measures the maturity of the underlying technology — not its manufacturing readiness or commercial success. It is the standard NASA / DoD scale.
Scale:
  1. Basic principles observed - research begun; no implementation yet (literature review, hypothesis only).
  2. Concept formulated - practical applications articulated; speculative, no proof or detailed analysis (white paper, concept sketch).
  3. Proof of concept - active R&D; analytical or experimental work shows critical function in a controlled setting (bench-top experiment).
  4. Lab-validated component - components integrated and validated in a laboratory environment (working subsystem, lab demo).
  5. Validated in relevant environment - components validated in a relevant (not yet operational) environment (breadboard tested in field-like conditions).
  6. Prototype in relevant environment - system or subsystem prototype demonstrated outside the lab (working prototype tested in field-like conditions).
  7. Prototype in operational environment - system prototype demonstrated in real conditions (pilot deployment, beta with real users).
  8. System qualified - actual system completed and qualified through test and demonstration (production-intent unit, certifications).
  9. System proven - actual system proven through successful operations (sustained commercial deployment).
Client information:
  Company description: {{contact.company_description}}
  Where they are today: {{contact.where_are_you_today}}
  Current state of technology / product: {{contact.current_state_of_your_technology_product}}
  Patents: {{contact.patents}}
  Independent validation: {{contact.independent_validation}}
Task: Score this client on the TRL scale (1-9). Use field "Current state of technology / product" as the primary signal — it maps directly to TRL levels 1-8. Patents and independent validation are corroborating evidence: granted patents and regulatory clearance suggest higher TRL. Where they are today and the company description provide context for borderline cases.
If the client's offering is primarily software with no novel technology (e.g., a standard CRUD web app), TRL is generally less meaningful; score conservatively and lower confidence.
OUTPUT: Respond with a single integer between 1 and 9. No explanation, no other text, no formatting. Just the number.
```

### MRL
```
You are a Manufacturing Readiness Level (MRL) classifier for Lean Rocket Lab, a Michigan-based startup incubator. Score the client below on the MRL scale (1-10).
Scale:
  1. Manufacturing implications identified.
  2. Manufacturing concepts identified.
  3. Manufacturing proof of concept.
  4. Lab-environment production capability.
  5. Production-relevant environment (component).
  6. Production-relevant environment (system).
  7. Production-representative environment.
  8. Pilot line capability.
  9. Low-rate production.
  10. Full-rate production.
Client information:
  Company description: {{contact.company_description}}
  Where they are today: {{contact.where_are_you_today}}
  How is your product manufactured today: {{contact.how_is_your_product_manufactured_today}}
  Manufacturing partner status: {{contact.manufacturing_partner_status}}
Use "How is your product manufactured today" as the primary signal — it maps almost directly to MRL 1-7. Manufacturing partner status corroborates ("actively producing with us" suggests MRL 6+).
If the client selected "Not yet manufactured" (typically software-only or pre-prototype), score MRL = 1.
OUTPUT: Respond with a single integer between 1 and 10. No explanation, no other text. Just the number.
```

### CRL
```
You are a Commercial Readiness Level (CRL) classifier for Lean Rocket Lab, a Michigan-based startup incubator. Score the client below on the CRL scale (1-9).
Scale:
  1. Opportunity hypothesis - market opportunity hypothesized; no customer contact yet.
  2. Value proposition formulated - segment and value prop articulated; customer discovery.
  3. Problem-solution fit - evidenced through interviews, LOIs, or design partnerships.
  4. Early customer trials - first paid pilots or trials; PMF hypothesized but not validated.
  5. Product-market fit - PMF validated with early adopters; repeated paid usage.
  6. Initial market traction - repeatable sales motion; multiple paying customers; initial revenue.
  7. Scaling go-to-market - proven channels; growing revenue; first hires beyond founders.
  8. Established market presence - recognized in the market; sustainable revenue.
  9. Market leadership - mature commercial operation; market leader.
Client information:
  Company description: {{contact.company_description}}
  Where they are today: {{contact.where_are_you_today}}
  Annual revenue (last 12 months): ${{contact.annual_revenue}}
  Revenue stage: {{contact.revenue_stage}}
  Number of paying customers today: {{contact.number_of_paying_customers_today}}
  Where they are with selling: {{contact.where_you_are_with_selling}}
  Self-reported product-market fit: {{contact.have_you_found_product_market_fit}}
"Where they are with selling" is the primary signal — it maps directly to CRL 1-8. Paying customers and revenue corroborate. PMF = Yes pushes toward 5+; Working on it suggests 3-4; No suggests ≤3.
If inputs conflict (e.g., "Scaling" but 0 paying customers), trust the more conservative signal.
OUTPUT: Respond with a single integer between 1 and 9. No explanation, no other text. Just the number.
```

### MRL/TRL/CRL Rationale (initial)
```
TRL = {{chatgpt.16.response}}
MRL = {{chatgpt.17.response}}
CRL = {{chatgpt.18.response}}
You are documenting the AI scoring rationale for a Lean Rocket Lab tech-path client. The TRL, MRL, and CRL scores have already been assigned. Write a clear, brief note explaining what informed each score so LRL staff can understand the reasoning later.
For reference, the scales are:
TRL (Technology Readiness Level, 1-9):
  1. Basic principles observed
  2. Concept formulated
  3. Proof of concept
  4. Lab-validated component
  5. Validated in relevant environment
  6. Prototype in relevant environment
  7. Prototype in operational environment
  8. System qualified
  9. System proven
MRL (Manufacturing Readiness Level, 1-10):
  1. Manufacturing implications identified
  2. Manufacturing concepts identified
  3. Manufacturing proof of concept
  4. Lab-environment production capability
  5. Production-relevant environment (component)
  6. Production-relevant environment (system)
  7. Production-representative environment
  8. Pilot line capability
  9. Low-rate production
  10. Full-rate production
CRL (Commercial Readiness Level, 1-9):
  1. Opportunity hypothesis
  2. Value proposition formulated
  3. Problem-solution fit
  4. Early customer trials
  5. Product-market fit
  6. Initial market traction
  7. Scaling go-to-market
  8. Established market presence
  9. Market leadership
Client information:
  Company description: {{ contact.company_description }}
  Where they are today: {{ contact.where_are_you_today }}
  Current state of technology: {{ contact.current_state_of_your_technology_product }}
  Patents: {{ contact.patents }}
  Independent validation: {{ contact.independent_validation }}
  Manufacturing approach: {{ contact.how_is_your_product_manufactured_today }}
  Manufacturing partner: {{ contact.manufacturing_partner_status }}
  Annual revenue: ${{ contact.annual_revenue }}
  Number of paying customers: {{ contact.number_of_paying_customers_today }}
  Selling stage: {{ contact.where_you_are_with_selling }}
  Self-reported product-market fit: {{ contact.have_you_found_product_market_fit }}
Scores already assigned:
  TRL = {{chatgpt.6.response}}
  MRL = {{chatgpt.17.response}}
  CRL = {{chatgpt.18.response}}
Write a note with three short sections (TRL, MRL, CRL). Each section: 1-2 sentences citing the specific input(s) that drove the score. Reference the rubric level name (e.g., "TRL 4 Lab-validated component") and actual input values. If a score involved an edge-case interpretation (e.g., software-only MRL = 1, borderline calls), note that briefly.
Output exactly in this format with no additional text:
Stage Scoring — Tech Path
TRL = {{chatgpt.16.response}}
[1-2 sentences referencing rubric level name and specific input evidence]
MRL = {{chatgpt.17.response}}
[1-2 sentences referencing rubric level name and specific input evidence]
CRL = {{chatgpt.18.response}}
[1-2 sentences referencing rubric level name and specific input evidence]
```

### Churchill (stage)
```
You are a Churchill & Lewis stage classifier for Lean Rocket Lab, a Michigan-based startup incubator. Score the client below on the Churchill scale (1-5).
Scale:
  1. Existence - getting customers, delivering product. Owner does most things. Few employees. Cash tight.
  2. Survival - workable business, enough customers and operations to deliver. Main concern: revenue vs expenses.
  3. Success - healthy and profitable. Owner faces choice: stay or grow.
  4. Take-off - rapid growth, delegation challenges, cash strapped despite growth.
  5. Resource Maturity - substantial resources, professional management, established systems.
Client information:
  Company description: {{contact.company_description}}
  Where they are today: {{contact.where_are_you_today}}
  Date business founded: {{contact.date_of_incorporation}}
  Current FTE: {{contact.number_of_full_time_equivalents_fte}}
  Planned FTE next 12 months: {{contact.number_of_fte_you_anticipate_hiring_in_the_next_12_months}}
  Annual revenue: ${{contact.annual_revenue}}
  Revenue stage: {{contact.revenue_stage}}
  Owner involvement: {{contact.owner_involvement}}
  Cash flow today: {{contact.cash_flow_today}}
  Locations / sites: {{contact.locations_sites_of_operation}}
  Management layer: {{contact.management_team}}
Stage rules:
  Stage 1 - cash struggling, owner does almost everything, business < ~12 months old.
  Stage 2 - cash breaking even, owner still central, small team, consistent customers.
  Stage 3 - consistently profitable, healthy business.
  Stage 4 - multiple locations OR >50% increase in FTE planned OR establishing management team.
  Stage 5 - mature, multi-location, professional management team in place.
OUTPUT: Respond with a single integer between 1 and 5. No explanation, no other text. Just the number.
```

### Churchill Sub-Stage
```
You are determining the Churchill sub-stage (III-D vs III-G) for a Lean Rocket Lab client.
Churchill Stage 3 (Success) has two sub-stages:
  III-D (Disengagement) - owner has chosen to stay at this size, extract profits, use business as platform for other interests. Modest growth plans.
  III-G (Growth) - owner is reinvesting profits and preparing for take-off. Building systems and management talent.
The client's Churchill stage has been determined as: {{churchill_score}}
If the stage is NOT 3, output exactly: N/A
If the stage IS 3, decide III-D or III-G using the rules below.
Client information:
  Current FTE: {{contact.number_of_full_time_equivalents_fte}}
  Planned FTE next 12 months: {{contact.number_of_fte_you_anticipate_hiring_in_the_next_12_months}}
  Cash flow today: {{contact.cash_flow_today}}
  Management layer: {{contact.management_team}}
  Where they are today: {{contact.where_are_you_today}}
Sub-stage rules (only if stage = 3):
  III-D - cash flow consistently profitable, planned FTE growth modest (<25% increase), management is owner-only or owner + few supervisors. Owner holding steady.
  III-G - cash flow profitable AND (planned FTE growth >25% OR management team being established). Owner investing in growth.
OUTPUT: Respond with exactly one of: III-D, III-G, or N/A. No explanation, no other text.
```

### Churchill Rationale (initial)
```
You are documenting the AI scoring rationale for a Lean Rocket Lab service-path client. The Churchill stage and sub-stage have already been assigned. Write a clear, brief note explaining what informed the score.
For reference, the Churchill scale (1-5):
  1. Existence — getting customers, owner does most things, few employees, cash tight
  2. Survival — workable business, consistent customers, main concern is revenue vs expenses
  3. Success — healthy and profitable, owner faces stay-or-grow choice
     III-D (Disengagement) sub-stage: owner stays at this size, extracts profits
     III-G (Growth) sub-stage: owner reinvests, prepares for take-off
  4. Take-off — rapid growth, delegation challenges, cash strapped despite growth
  5. Resource Maturity — substantial resources, professional management, established systems
Client information:
  Company description: {{ contact.company_description }}
  Where they are today: {{ contact.where_are_you_today }}
  Date business founded: {{ contact.date_of_incorporation }}
  Current FTE: {{ contact.number_of_full_time_equivalents_fte }}
  Planned FTE next 12 months: {{ contact.number_of_fte_you_anticipate_hiring_in_the_next_12_months }}
  Annual revenue: ${{ contact.annual_revenue }}
  Owner involvement: {{ contact.owner_involvement }}
  Cash flow today: {{ contact.cash_flow_today }}
  Locations / sites: {{ contact.locations_sites_of_operation }}
  Management layer: {{ contact.management_team }}
Scores already assigned:
  Churchill Stage = {{chatgpt.20.response}} (1=Existence, 2=Survival, 3=Success, 4=Take-off, 5=Resource Maturity)
  Sub-Stage = {{chatgpt.21.response}}
Write a note with one main section for Churchill stage (2-3 sentences citing the specific service inputs that drove the stage). Reference the rubric stage name (e.g., "Stage 2 Survival") in the prose. Then a brief sub-stage note: if sub-stage is N/A, just state "Sub-stage not applicable for Stage {{chatgpt.20.response}}." If sub-stage is III-D or III-G, give 1 sentence explaining the growth-posture call (typically based on planned FTE growth and management layer evolution).
Output exactly in this format with no additional text:
Stage Scoring — Service Path
Churchill Stage = {{chatgpt.20.response}}
[2-3 sentences referencing rubric stage name and specific input evidence]
Sub-Stage = {{chatgpt.21.response}}
[1 sentence explaining or noting N/A]
```

## RE-SCORE

> Classifier prompts (TRL / MRL / CRL / Churchill / Churchill sub-stage) are **identical** to the
> initial versions above. Only the two rationale prompts differ — they compare prior→new. Verbatim:

### MRL/TRL/CRL Rationale (re-score)
```
You are documenting the change in a Lean Rocket Lab tech-path client's stage scores after a re-scoring run. Compare the previous scores and rationale to the new scores and current inputs. Write a brief note explaining what changed (or didn't) and why.
For reference, the scales are:
TRL (Technology Readiness Level, 1-9):
  1. Basic principles observed
  2. Concept formulated
  3. Proof of concept
  4. Lab-validated component
  5. Validated in relevant environment
  6. Prototype in relevant environment
  7. Prototype in operational environment
  8. System qualified
  9. System proven
MRL (Manufacturing Readiness Level, 1-10):
  1. Manufacturing implications identified
  2. Manufacturing concepts identified
  3. Manufacturing proof of concept
  4. Lab-environment production capability
  5. Production-relevant environment (component)
  6. Production-relevant environment (system)
  7. Production-representative environment
  8. Pilot line capability
  9. Low-rate production
  10. Full-rate production
CRL (Commercial Readiness Level, 1-9):
  1. Opportunity hypothesis
  2. Value proposition formulated
  3. Problem-solution fit
  4. Early customer trials
  5. Product-market fit
  6. Initial market traction
  7. Scaling go-to-market
  8. Established market presence
  9. Market leadership
Previous scores (from contact record before this update):
  TRL = {{contact.trl_current}}
  MRL = {{contact.mrl_current}}
  CRL = {{contact.crl_current}}
Previous rationale:
{{contact.latest_tech_stage_rationale}}
New scores (just computed):
  TRL = {{chatgpt.1.response}}
  MRL = {{chatgpt.3.response}}
  CRL = {{chatgpt.4.response}}
Current client inputs:
  Company description: {{ contact.company_description }}
  Where they are today: {{ contact.where_are_you_today }}
  Current state of technology: {{ contact.current_state_of_your_technology_product }}
  Patents: {{ contact.patents }}
  Independent validation: {{ contact.independent_validation }}
  Manufacturing approach: {{ contact.how_is_your_product_manufactured_today }}
  Manufacturing partner: {{ contact.manufacturing_partner_status }}
  Annual revenue: ${{ contact.annual_revenue }}
  Number of paying customers: {{ contact.number_of_paying_customers_today }}
  Selling stage: {{ contact.where_you_are_with_selling }}
  Self-reported product-market fit: {{ contact.have_you_found_product_market_fit }}
For each scale (TRL, MRL, CRL):
- If the score changed, explain what advanced (or regressed) in the inputs, and reference the rubric level names (e.g., "moved from TRL 4 Lab-validated component to TRL 6 Prototype in relevant environment")
- If the score didn't change, write a brief "no change" note (1 sentence)
Output exactly in this format with no additional text:
Stage Scoring — Tech Path (Re-Score)
TRL: {{ contact.trl_current }} → {{chatgpt.1.response}}
[1-3 sentences referencing rubric level names and specific input changes]
MRL: {{ contact.mrl_current }} → {{chatgpt.3.response}}
[1-3 sentences referencing rubric level names and specific input changes]
CRL: {{ contact.crl_current }} → {{chatgpt.4.response}}
[1-3 sentences referencing rubric level names and specific input changes]
```

### Churchill Rationale (re-score)
```
You are documenting the change in a Lean Rocket Lab service-path client's Churchill stage after a re-scoring run. Compare the previous score and rationale to the new score and current inputs. Write a brief note explaining what changed (or didn't) and why.
For reference, the Churchill scale (1-5):
  1. Existence — getting customers, owner does most things, few employees, cash tight
  2. Survival — workable business, consistent customers, main concern is revenue vs expenses
  3. Success — healthy and profitable, owner faces stay-or-grow choice
     III-D (Disengagement) sub-stage: owner stays at this size, extracts profits
     III-G (Growth) sub-stage: owner reinvests, prepares for take-off
  4. Take-off — rapid growth, delegation challenges, cash strapped despite growth
  5. Resource Maturity — substantial resources, professional management, established systems
Previous scores (from contact record before this update):
  Churchill Stage = {{ contact.churchill_current }}
  Sub-Stage = {{ contact.churchill_substage_current }}
Previous rationale:
{{ contact.latest_churchill_stage_rationale }}
New scores (just computed):
  Churchill Stage = {{chatgpt.5.response}}
  Sub-Stage = {{chatgpt.6.response}}
Current client inputs:
  Company description: {{ contact.company_description }}
  Where they are today: {{ contact.where_are_you_today }}
  Date business founded: {{ contact.date_of_incorporation }}
  Current FTE: {{ contact.number_of_full_time_equivalents_fte }}
  Planned FTE next 12 months: {{ contact.number_of_fte_you_anticipate_hiring_in_the_next_12_months }}
  Annual revenue: ${{ contact.annual_revenue }}
  Owner involvement: {{ contact.owner_involvement }}
  Cash flow today: {{ contact.cash_flow_today }}
  Locations / sites: {{ contact.locations_sites_of_operation }}
  Management layer: {{ contact.management_team }}
Document:
- Churchill stage: 2-3 sentences. Reference the rubric stage name (e.g., "Stage 2 Survival"). If the stage changed, what advanced or regressed? Cite specific service inputs. If unchanged, brief note.
- Sub-stage: 1-2 sentences. If both old and new are N/A, just state "Sub-stage not applicable." If changed (e.g., III-D → III-G), briefly explain the growth-posture shift.
Output exactly in this format with no additional text:
Stage Scoring — Service Path (Re-Score)
Churchill Stage: {{ contact.churchill_current }} → {{chatgpt.5.response}}
[2-3 sentences referencing rubric stage name and specific input evidence]
Sub-Stage: {{ contact.churchill_substage_current }} → {{chatgpt.6.response}}
[1-2 sentences]
```
