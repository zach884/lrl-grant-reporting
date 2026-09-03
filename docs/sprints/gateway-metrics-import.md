# Brief — import the Gateway workbooks as dated metrics snapshots

> **Written 2026-09-02** with Zach, from live measurement of all 7 workbooks.
> Replaces the rejected "backfill 382 contacts stamped to the current period" plan. Zach: *"I do not
> want to stamp all of our previous records to the current period"* — correct, that would have
> fabricated history. This gets **real** periods instead.
> Parent sprint: `sprint-c-tc-report.md`. Sibling: `grant-headline-fields.md`.

## Why this source and not the contacts

A contact holds only its **most recent** Client Reporting answers, and **nothing on the contact records
when the form was submitted** — every DATE-type contact field was checked; there is no submission date.
So a contact-driven backfill can only file every snapshot under one assumed period.

The Gateway workbooks are the opposite: **7 funder-submitted semi-annual reports, one row per company,
already reconciled and sent to MEDC.** Provenance does not get better than "the numbers we submitted".

Measured across `Past Grant Reports/Gateway/`:

| Workbook | Rows | With email |
|---|---|---|
| Apr 2023 | 33 | 31 |
| Oct 2023 | 29 | 29 |
| Apr 2024 | 34 | 34 |
| Oct 2024 | 28 | 28 |
| Apr 2025 | 32 | 32 |
| Oct 2025 | 35 | 35 |
| Apr 2026 | 36 | 36 |
| **Total** | **227** | **225 (99%)** |

## The period derivation — reuse `reportingPeriodFor()`, add nothing

Zach's rule, already encoded in `lib/activities/reportingPeriod.ts`: *"Client Reporting is typically
done in September for an October 15th date, and in March for an April 15th date."* Windows end
**Feb-end** and **Aug-end**. Gateway's April/October cadence lands exactly on those boundaries, so
passing each workbook's nominal submission date to the existing function yields the right period with
**no new period logic**:

| Workbook | Pass as `submittedAt` | → `reporting_period` | Label |
|---|---|---|---|
| Apr 2023 | 2023-04-15 | **2023-02-28** | Sep 2022–Feb 2023 |
| Oct 2023 | 2023-10-15 | **2023-08-31** | Mar–Aug 2023 |
| Apr 2024 | 2024-04-15 | **2024-02-29** | Sep 2023–Feb 2024 |
| Oct 2024 | 2024-10-15 | **2024-08-31** | Mar–Aug 2024 |
| Apr 2025 | 2025-04-15 | **2025-02-28** | Sep 2024–Feb 2025 |
| Oct 2025 | 2025-10-15 | **2025-08-31** | Mar–Aug 2025 |
| Apr 2026 | 2026-04-15 | **2026-02-28** | Sep 2025–Feb 2026 |

Seven distinct periods. **None collides with the live snapshot created 2026-09-02** (period
`2026-08-31`), so the import cannot disturb it. Assert these seven values in a test rather than
trusting the derivation silently — the period is half the idempotency key.

## Column map — `Companies Served` tab, header row 4, data from row 5

| Col | Gateway header | Metrics activity field |
|---|---|---|
| C | Company Name | (resolution fallback only — **never** the match key, see below) |
| K | Email Address | **the resolution key** |
| N | Commercialized Products | `number_of_new_products_commercialized_in_the_last_6_months` |
| O | Products in the Commercialization Pipeline | `number_of_products_in_the_commercialization_pipeline` |
| P | Jobs Created | `jobs_created_in_the_last_6_months` |
| Q | Jobs Retained | `jobs_retained_in_the_last_6_months` |
| R | MEDC Funds Awarded to Companies | `medc_funding_received_in_the_last_6_months` |
| S | SBIR, STTR, & Other Federal Funding | `federal_funding_including_sbir_and_sttr_received_in_the_last_6_months` |
| T | Venture Capital | `venture_capital_funding_received_in_the_last_6_months` |
| U | Angel Funds | `angle_investor_funding_received_in_the_last_6_months` *(sic — the live field key is misspelled "angle")* |
| V | Bank/Loan | `bank_loans_received_in_the_last_6_months` |
| W | Owner Investment | `owner_investment_in_the_last_6_months` |
| X | New Sales (Increase in Revenue) | `new_sales_in_the_last_6_months` |
| Y | Other | `other_funding_received_in_the_last_6_months` |
| Z | Other Explanation | `describe_other_funding_received` |

Every Gateway figure is already "in the last 6 months", which is exactly what these fields mean. No
unit conversion, no re-basing. D/E–H (NAICS, address) are **company** attributes — do not write them
onto the activity; the company already owns them and the enrichers own their provenance.

## Identity — claim the SAME key the form adapter would

Activity identity is **(source, source_record_id) — both halves**. This is the 2026-08-19 lesson that
nearly created 54 duplicate grants, and it applies directly here.

Use source **`Form`** with `sourceRecordId = <contactId>:<periodEnd>` — the exact key
`sources/form.ts` computes. Consequence, and it is the desired one: if a real Client Reporting
submission ever covers one of these seven periods, it **updates** the imported snapshot instead of
creating a second one for the same half-year. A follow-on-funding figure counted twice is precisely
the error that survives review because both rows look plausible.

⚠️ Do **not** invent a `gateway-<period>:row-N` key. It reads tidier and it silently permits a
duplicate per period. Record the spreadsheet provenance in `activity_notes` and the source workbook
name instead — provenance is a field, not an identity.

## Resolution — email only

Apply the house rule: **email → contact → `contact.businessId`**. Never match these workbooks on
company name. Measured on the TC sheet 2026-08-31: name matching produced false negatives
("Chem Clean Treatment Services" vs GHL "ChemClean Treatment") and, worse, one false positive that
resolved to an entirely different business. 225 of 227 rows carry an email, so name fallback is a
2-row problem — report those two rather than guessing.

Apply `lib/sync/identityGuard.ts`-style comparison: if the workbook's company name disagrees with the
resolved company, **flag for review, do not attach**. Attaching a snapshot to the wrong company is
invisible afterwards.

## 🔴 Known gaps — state them, don't paper over them

1. **FTE is absent from Gateway entirely.** There is no "Current FTE" column in any of the 7
   workbooks. So `current_number_of_full_time_equivalents_fte` history is **unrecoverable** — and that
   is the field **SBSH column N ("Current FTE's")** asks for by name. This import does not fix SBSH's
   FTE history; nothing will. Say so in the readiness report.
2. **Cohort is ~33 companies per period, not 897.** Gateway's lens is ~78 companies. This import serves
   Gateway (whose outcome half was blocked almost entirely by having 0 metrics) and contributes to TC
   KPIs 12–15. It is not a general metrics backfill and should not be described as one.
3. **⚠️ Two field-naming warts to avoid inheriting** (found in the live snapshot 2026-09-02):
   there are **two FTE fields** (`current_number_of_full_time_equivalents_fte` vs
   `number_of_full_time_equivalents_fte`) — bind the `current_` one explicitly; and copyrights
   issued is stored under `..._copy_3nt_copy`, indistinguishable from "applied for" by key. Neither is
   supplied by Gateway, so this import does not have to solve them — just don't bind them wrongly.

## Procedure

Dry-run → review → apply, per CLAUDE.md. `upsertActivity` with `plan: true` for the dry run, so the
review shows `would-create` / `would-update` / `noop` per row rather than restating intent. Import
oldest workbook first, so a mistake is caught on 33 rows and not 227.

## Acceptance

1. All seven periods present, with the exact `reporting_period` values in the table above, asserted by test.
2. ≤2 rows unresolved (the two without email), reported by company name — not silently skipped.
3. Zero rows attached to a company whose name disagrees with the resolved one; disagreements land in review.
4. A re-run of every workbook reports **all `noop`** — no creates, no rewrites.
5. The live 2026-09-02 snapshot (`2026-08-31`) is untouched.
6. A Gateway report can be regenerated for at least two distinct periods and reconciled against the
   submitted workbook it came from.

---

## Build notes — what live measurement changed (2026-09-02/03)

The brief held up well: all 15 column headers are byte-identical across all seven workbooks (so the
positional map is asserted, not prefix-matched), the extraction reproduces the row counts exactly
(227 rows, 225 with email), and `reportingPeriodFor()` returns the seven periods in the table above
with no new period logic. Four things were different.

### 1. ✅ Column V had no field — and that was a live bug, not an import gap

The brief mapped `V Bank/Loan` to `bank_loans_received_in_the_last_6_months`. **That field did not
exist** on the activities object — verified against live, all 108 fields.

`contact.bank_loans_received_in_the_last_6_months` *does* exist, because the Client Reporting form
asks the question. And `sources/form.ts` builds its map by matching bare keys, so with no key to match
**every real Client Reporting submission was silently dropping the figure** — not just this import.
Mapping a funder's column is what surfaced it.

Zach: *"Good catch on the bank loan drop. We need to get that back in here."* Created via
`scripts-ts/add-bank-loan-field.ts` (dry-run → apply): id `PIPQzCwc8WRU1xiY7QB7`, **NUMERICAL**, in
folder `d7mBwQ2nDuu2le1uE2En` — both taken from its seven siblings rather than chosen, since a
MONETORY field among eight NUMERICAL ones aggregates differently in the report engine and a field in
the wrong folder is invisible to whoever fills the form in.

Verified wired end-to-end: the field is in the `metrics` field set (which is derived from the live
catalog by folder name, so no code change was needed) and its contact twin exists — so the live form
copies it from here on. The only metrics fields left without a contact twin are `activity_owner`,
`program__grant_association` and `reporting_period`, all of which are set by the adapter and correctly
have none.

It was **not** folded into `other_funding_received_in_the_last_6_months`. "Other" is a reported
category with its own explanation field, and a funder totals the columns — merging bank debt into it
makes two figures wrong while still reconciling to the right grand total.

### 2. 13 Apr-2023 rows report nothing, and are skipped rather than zeroed

Checked against the raw cells: 13 of the 33 Apr 2023 rows are blank across N–Z. No other workbook has
any. Those companies were listed as served but filed no figures.

They are skipped. Writing zeros would assert "raised nothing, created no jobs", which is a different
claim from "did not report" — and it is the claim a funder would read. Note the corollary, already in
`number()`: a cell containing **0** *is* a reported figure and is imported as one, because Gateway's
own instruction is to enter 0.

### 3. 🔴 Email-only left 51 rows unresolved, not the ≤2 the brief predicted

Acceptance criterion 2 assumed the only unresolvable rows were the two without an email. Measured:
**51 rows had an email that no GHL contact holds**, spread across all seven workbooks (not just the
old ones), and some were companies that plainly exist — Blue Entity, Mport Media Group, Ulendo.

Same failure the sheet import hit: the workbook's address and GHL's address are two different emails
for one business. So a second step was added, guarded exactly as the sheet import's is:

1. email → contact → `contact.businessId`, with `checkCompanyIdentity` confirming the company
2. else company **name**, accepted **only on a unique hit** (exact normalized, or `namesLookAlike`)
3. else review — never a guess

Measured over the 54 unresolved rows: step 2 recovers **27, with zero ambiguous matches**; the other
27 companies are genuinely absent from GHL, so there is nothing to attach them to. The brief's real
point stands and is honoured — a name match is refused whenever it hits more than one company,
because the TC sheet produced a false positive onto an entirely different business, and a snapshot on
the wrong company is invisible afterwards.

### 4. A company+period guard, because a name-resolved row may have no contact to key on

`<contactId>:<periodEnd>` needs a contact. Of the 27 name-recovered rows, **17 companies have exactly
one contact** — that is the person a real submission would come from, so those carry the form's own
key and can never be duplicated by one. **10 have two**, and which of them would file is unknowable.

Rather than attach a specific wrong person, those are company-keyed (`company:<id>:<periodEnd>` — a
prefix that cannot collide with a form key, at the correct cardinality of one per company per
half-year), and a new guard closes the hazard the brief was right to warn about: before writing,
`snapshotOnFile` is consulted, and **an existing snapshot for that company and period is updated
whatever key it carries**, rather than a second one being created beside it. That index is empty on
the first run and earns its keep on the day a real submission arrives for a period this import
already covered.

### Unchanged from the brief

- Source `Form`, key `<contactId>:<periodEnd>` — the form adapter's own key, so a real submission
  updates the snapshot instead of duplicating it. No `gateway-<period>:row-N`.
- `onlyIfAbsent: ['activity_date']` only. The figures must stay correctable by a real submission;
  only the date the snapshot is filed under is set-once.
- No company attributes (NAICS, address) written onto the activity — asserted by test.
- 🔴 FTE remains unrecoverable. No Gateway workbook has a Current FTE column, so SBSH column N has no
  history and never will.
