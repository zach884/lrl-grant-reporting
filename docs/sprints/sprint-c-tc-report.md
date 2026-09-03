# Sprint C — Regenerate the TC Report, End to End

> **Written 2026-09-02** in a planning chat with Zach, after a full audit of state vs. repo.
> Supersedes the "Sprint C" line in `PROJECT_ROADMAP.md` by narrowing it: **one grant, not four.**
> Companion specs: `report-engine-design.md` (the design) · `grant-definitions.md` (the four lenses) ·
> `funder-field-trace.md` (column → field) · `sheet-import.md` (the row source).

## Why this sprint, framed this way

The data layer has been "nearly ready" for six weeks and the report engine has never been started.
Every readiness gate is met or explicitly declared non-blocking. The remaining risk is not the data —
it is that **building a generic four-grant engine has no finish line**, so it keeps losing to whatever
defect surfaced that week.

So: one vertical slice, one funder, one workbook, one number to match. Everything not on TC's critical
path is out of scope by name. The generic parts (predicate registry, canonical metrics, versioned
column sets) get built because TC needs them — not before, and not more than TC needs.

## Acceptance test — in two phases, and the ORDER MATTERS

**Zach, 2026-09-02: *"The companies served sheet is the most important part of this. We can build out
the KPI ability after getting a workbook in the right format."*** So this sprint is sequenced
row-level-first, and the KPI tab is explicitly phase 2.

### Phase 1 — the deliverable
> Produce the **row-level companies-served sheet** as a real workbook, in the funder's format, from
> canonical GHL data — and reconcile it against `Past Grant Reports/Trusted Connector Report.xlsx`
> ("Cumulative Reporting", header row 3, one row per service event).

Right format means the actual thing, not an approximation: header row 3, the real column order A→AE,
col K restricted to the sheet's own three dropdown strings, booleans in L–Q the way the sheet writes
them, and the `__` / `Duplicate` helper columns present. **A workbook Zach can open and submit.**

Reconcile, not "match exactly." A variance is acceptable **if it is explained**: a row the sheet has
and we don't, with a named reason, is a pass. A row we can't account for either way is a fail. Phase 1
ends with a workbook plus a written variance report.

### Phase 2 — the KPI tab
Only once phase 1's workbook is right. The aggregate KPI/Smartsheet numbers are computed **over the
phase-1 row set**, which is why they cannot come first — a KPI built before the rows are trustworthy
is a number nobody can defend, and it would have to be rebuilt anyway.

⚠️ **Interpretation flagged:** "the companies served sheet" is read here as **TC's row-level tab** —
the businesses-served listing, as opposed to TC's separate KPI sheet. If it meant the **SBSH**
"Companies Served Spreadsheet" as the funder to target first, say so — swapping the target workbook is
cheap right now and expensive after phase 1 is built.

## Phase 2 scoreboard — TC's 8 required KPIs

**This is the PHASE 2 burn-down, not the sprint's.** Phase 1 is measured by the workbook. Kept here
because it says which columns must be trustworthy in phase 1 for each KPI to be computable later —
the KPI column below is the reason a given column matters, not a task to start now.

| # | Required KPI | Target | Bound to | State entering sprint |
|---|---|---|---|---|
| 2 | Businesses in a Geographically Disadvantaged Area | 100 | col K computed column | 🟡 **decided this session** — buildable, nothing to collect |
| 3 | **Attendees** at technology and innovation events | 100 | `workshop_event` ∧ Tech/Innovation bucket | 🔴 phase 6 + classification. **See the door-process risk below** |
| 5 | Total businesses served in grant period | 100 | distinct businesses across qualifying rows | 🟢 the one that already worked |
| 6 | Networking/mentorship **initiatives** executed | 12 | `workshop_event` ∧ Networking/Mentorship bucket | 🔴 phase 6 + classification |
| 7 | Businesses supported with 1:1 technical assistance | 25 | col L | 🟢 **unblocked** — fix 2 (15/15 modality) + sheet import (271 rows) |
| 8 | Businesses supported through small group TA | 22 | col M | 🟡 needs `modality=group` on the group-TA rows |
| 14 | Facilitated capital access | 35 | cols V/W (capital-provider referral) | 🟡 counterparty now captured (`ed2cc11`) — verify population |
| 16 | Referrals to other Small Business Ecosystem Partners | 35 | cols X/Y | 🟢 65 referral rows imported |

**Note the asymmetry in KPI 3 vs 6, it is easy to get wrong:** KPI 3 counts **attendees**, KPI 6 counts
**events**. Same two buckets, two different grains. Both come from the same classification pass.

**The "only 1 of 8 is producible" figure in `PROJECT_STATE.md` is stale** — it predates the sheet
import. Re-run the census (task below) before planning around it; the honest number is likely 3–4.

### 🔴 Risk that is not an engineering problem
Every ENDED Wix event reports **0 attended** — the check-in app isn't being used at the door. KPI 3's
target is 100 attendees. Wiring phase 6 perfectly still reports ~zero until the door process changes.
**This needs an operational fix at LRL, and it needs to start now**, because attendance for events
already held may be unrecoverable. Flagging it in the sprint rather than discovering it at submission.

---

## Day 0 gate — four unlocks, none of them code

The sprint does not start until these land. They are ~20 minutes total and they have failed to happen
for five consecutive maintenance runs, which is why they are a gate with a name rather than a bullet
in a brief.

1. **⭐ GHL webhook #3 — Client Reporting.** `POST https://lrl-grant-reporting.vercel.app/api/form-sync`,
   body `{"contactId":"{{contact.id}}","formId":"ed03BbRGWrc6Ugtwr9JB"}`, headers `x-webhook-secret`
   + `x-vercel-protection-bypass` (copy both from the working webhook #1). Then
   `npx vite-node scripts-ts/form-ingest-run.ts metrics --apply`.
   → 0 metrics activities exist today, and each submission overwrites its contact. Every day costs a snapshot.
2. **GHL webhook #2 — Direct Grant Application.** Same, `formId` `0d8irJ6Ay6VQFajG06Go`.
   → grant headline fields are 0/63; without `grant_program` a grant cannot be attributed to TC vs SBSH.
3. **Wix Events read permission, including contact details.** The key lists 47 events but attendees
   come back `anonymized` and ticketed orders 404. The `wix-ghl` MCP reads the same site with real
   names — so this is a key scope, not an API limit. → sole source for KPIs 3 and 6.
4. **Un-pause the GHL "Contact Changed" workflow.** Safe: the loop's cause is disabled in config and a
   dry-run of the worst-affected record proposes 0 changes.

**Also housekeeping, before anything else:** the repo has **3 unpushed local commits** (today's
sheet-import corrections) and is **1 behind origin** (the CI `.env.local` fix). Merge and push first.

---

## Column bindings — TC row-level, now fully determined

Confirmed against the real workbook header row this session. `Q` is the notable one: a constant.

| Col | Header | Binding |
|---|---|---|
| B–I | Business Info | company attributes; **read owner name/email from the contact** (`business.phone`/`.email` are 0/897) |
| J | Minority Owned or Controlled | company demographic field |
| K | Geographically Disadvantaged Location? | **computed, ordered:** SEDI-owned → else `Geographic Area defined in Grant Agreement` (from HUBZone/OZ) → else COVID → else blank. Dropdown values are fixed by the sheet |
| L | 1:1 Technical Assistance | **`intake` ∨ (`technical_assistance` ∧ `modality=one_on_one`)** — TC does not distinguish the two; see the 9/02 correction below |
| M | Group Technical Assistance | `technical_assistance` ∧ `modality=group` — a workshop inside or for a program |
| N | Hosted a Tech or Innovation event | `workshop_event` ∧ event classified **Tech/Innovation** |
| O | Networking or mentorship initiative | `workshop_event` ∧ event classified **Networking/Mentorship** |
| P | Referral | `introduction_referral` |
| Q | Other | **always FALSE.** A constant, not a derivation — declared, not guessed |
| R–U | Direct Grant / date / reason / facilitated revenue | grant activity headline fields (gated on webhook #2) |
| V–AB | Referral counterparties + reason | `introduction_referral` counterparty (captured as of `ed2cc11`) |

`SEDI` = minority ∨ women ∨ veteran ∨ disabled — a derived OR over fields already held.

---

## 🔄 Correction, Zach 2026-09-02 — historical intake/TA classification is OUT of scope

Zach, mid-planning: *"I don't want to worry too much about the historical data for this and other
programs. We didn't do a good job of writing down the difference between intake meeting and TA
meetings so it would be super hard to go back and classify them all. **They all end up going on the
sheet as 1:1 TA for TC anyways.**"*

This makes the sprint smaller in three places, and it retires a chunk of the `sheet-import.md`
classification effort:

**1. TC col L takes both types.** `intake ∨ (technical_assistance ∧ modality=one_on_one)`. The
intake-vs-TA distinction **is not a TC blocker at all** — it never was, we just hadn't noticed the
funder doesn't ask. The 84-intake / 187-TA split measured on 8/31, the Wednesday-rule corroboration,
and the 79% same-date validation were all good work, and none of it is load-bearing for TC.

**2. The classification rule narrows for TC-sourced rows.** New rule: **default to `1:1 TA`, promote to
`intake` only when the notes literally say "Intake" somewhere.** This is stricter than the rule shipped
in `3d3e19e`, which promoted on notes *mentioning referrals or intros to be made*.
⬜ **Action: revisit the 11 TA→intake promotions** from that commit against the narrower rule. Some
will revert. Cheap to do — the importer can now correct its own records (`e910292`), which is exactly
why that fix mattered.

**3. SBSH has a real discriminator; TC borrows it by cross-reference.** SBSH col Z **`First Time
Served by the Hub`** is the signal we lack on TC: *"if that is yes and it is 1:1 TA type then it is
most likely an intake."* So SBSH rows classify properly from the sheet itself, and TC rows for the same
company and date can inherit that determination. TC keeps the 1:1-TA default where no cross-reference
and no "Intake" in the notes exists.

**No date repair, no calendar scraping, no back-classification pass.** Consistent with the standing
guidance that approximate dates are fine for history already reported.

### And a scoping warning for SBSH
**SBSH 2.0 is expected to arrive with a new reporting format.** Do not harden anything against the
current SBSH template. This is design rule 4 earning its keep — **version the lens and the column set
separately**, so a reissued template is clone-and-bump rather than a rebuild. It is also one more
reason SBSH is out of this sprint: building it now risks building it against a template about to be
replaced.

## Decisions locked this session

| Question | Decision |
|---|---|
| TC `small_business()` | **< 500 employees** (revenue threshold optional). Nobody in the cohort is close, so evaluate where known and pass through where unknown — non-binding in practice, documented on the output |
| TC grant period | **2024-08-01 → 2027-08-31.** Versioned config, not a constant ⚠️ the sheet's rows start 2025-09-30, so the grant's first ~14 months have no sheet coverage — expect a variance there and explain it |
| `LOCAL` granularity | **every `local` program acceptance within the grant period** counts. Needs the date-scoped `enrolled_in(program, at)` primitive, not a bare flag |
| TC event grain | **one row per attendee.** ⚠️ therefore KPI 5 must count **distinct businesses**, never row count |
| Event classification | **one-time AI pass over the 47 Wix events**, from the event description, two buckets, stored as a recomputing `derivedFrom` value — same pattern as the readiness tagger, individually overridable |
| Col K | computed column, ordered resolution, **nothing new stored** |
| Col Q | constant FALSE |
| Bare-contact subjects | **option B — create a lightweight company at first service.** Zach had no preference; taken as my call. Rationale: every funder row is business-shaped, it yields a stable dedup key, and it guards the double-count hazard where "Jane Smith" in period 1 and "Jane's Bakery LLC" in period 2 both look plausible on a cumulative sheet. **Flagged for review — say the word and it flips** |

---

## Workstreams, in dependency order

Re-sequenced 9/02 so the workbook comes first. Steps 1–4 are **phase 1**; 5–6 are **phase 2**.

**1 — The workbook writer.** Take a row set and emit the real TC workbook: header row 3, column order
A→AE, the sheet's own dropdown strings in col K, L–Q booleans written the way the sheet writes them,
`__` and `Duplicate` helpers present. Build it against a **hand-made row set first** so the format is
provably right before the row set is trustworthy — the two failures then can't hide each other.
*Done when:* Zach opens the output next to a real submission and cannot tell which is which by shape.

**2 — Company/contact columns (B–K).** The row's identity half. Read owner name and email from the
**contact** (`business.phone`/`.email` are 0/897). Col K is the computed ordered resolution. Also where
the data-hygiene bites: 27 spellings of `state`, 69 addresses holding the literal string `"undefined"`.

**3 — Predicate registry + the TC lens.** Named primitives in tested code (`sedi()`,
`naics_in(list, depth)`, `enrolled_in(program, at)`, `small_business()`, `in_state()`), composition in
config. Build only the five TC needs. *Done when:* the lens evaluates over ~897 companies and returns a
cohort size that is explainable.

**4 — Service columns (L–Q) + emit, then RECONCILE.** Row per qualifying activity, plus one row per
event attendee. Then the phase-1 variance report. **This is the deliverable.**

**5 — Canonical metrics layer.** Columns bind to named metrics, never straight to facts — "jobs
created" is already asked three different ways across the four grants, and binding to facts guarantees
grant #7 silently disagrees with #2. Phase 2, because it exists to serve the KPI tab.

**6 — The KPI tab + the generated readiness report.** Aggregates over the phase-1 row set. The
readiness report prints unbound columns, thin-population columns, cohort size per lens, and every
documented assumption. **An unbound column must be a declared state, never a silently blank cell.**

**Phase 6 (Wix attendance) + the event classification pass** sits across both: it is a **row source**
for phase 1 (attendees become rows) and the sole source for KPIs 3 and 6 in phase 2. Gated on Day 0
unlock #3. If the Wix permission is slow to land, phase 1 ships without event rows and says so in the
variance report rather than waiting.

## Explicitly out of scope

Named so they can't creep in. Each is cheap *after* TC, because TC forces the machinery to exist.

- **SBSH, Gateway, i4.0.** SBSH is TC with one option value changed — it becomes config, not code.
  i4.0 stays last regardless: its history is in a separate GHL sub-account and tab 2 has no field at all.
- **The 6 non-TC confirmations** in `grant-definitions.md` §7 (Gateway snapshot tie-break, age semantics,
  "created", D2's formal definition, SBSH intake/grant qualification, i4.0 tab 2).
- **Auto meeting logging / Zoom AI Companion.** Phase 3. The feasibility spike may run in parallel; the sprint does not depend on it.
- **Outcome surveys, internal dashboards.**
- **Incident items 4b, 5, 7** (non-converging escalation, fan-out bulk-safety, the duplicate
  "Grand Rapids SmartZone" records) — real, not TC-blocking. Item 7 gets a look only if it distorts the TC cohort.
- **Date repair on approximate sheet rows.** Zach: approximate dates are fine for history already reported.
- **Back-classifying historical intake vs TA.** Explicitly retired 9/02 — see the correction above.
- **Hardening against the current SBSH template.** SBSH 2.0 brings a new format.
- **The 74 note-less sheet TA records and the 37 cohort interviews.** Open questions in `sheet-import.md`, not blockers.

## Definition of done

**Phase 1 — the workbook (this is the sprint)**
1. All four Day 0 unlocks confirmed, with a green `nightly-activities.yml` run proving the ingest runs in CI.
2. A **real TC workbook** generated from config, in the funder's format, openable and submittable.
3. No code path specific to TC — the format is a writer, the lens and columns are config.
4. A written variance report against the real submission, every difference explained.

**Phase 2 — the KPI tab**
5. All 8 required KPIs produce a number over the phase-1 row set, or are declared unbound with a stated reason.

**Both**
6. `PROJECT_STATE.md` and `grant-definitions.md` updated; the spec committed and pushed.
