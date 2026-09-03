# Sprint D — Capture completeness, then label correctness

> **Defined 2026-09-03 with Zach. This SUPERSEDES Sprint C as the active sprint.**
> Sprint C (`sprint-c-tc-report.md`) is **shelved, not cancelled** — it restarts when the bar in §3 is met.
> Its column bindings and grant definitions stay current, because they are what tells this sprint which
> fields have to be trustworthy.

## 1. The reframe, in Zach's words

> *"It felt like we were trying to jump ahead and spit our reports but we didn't have the actual
> mechanisms in place to capture our activity types. The report to me is after we can capture the data.
> If we can capture it then we can label it, filter it, format it, etc. But if we can't get an exhaustive
> list of activities that would get reported on our grants then the rest of it doesn't matter."*

He is right, and the record backs him up. Sprint C's phase 1 is a **row-level companies-served workbook**
— one row per qualifying activity. Two of the seven activity types that feed those rows have
**essentially no records**: `workshop_event` is **0** and `introduction_referral` is **1**. A workbook
built today would be confidently, silently incomplete, and the reconciliation against the real TC
workbook — the acceptance test — would fail for a reason that has nothing to do with the engine.

**The dependency runs one way.** Capture → label → filter → format. Building the formatter first means
rebuilding it when the row set changes underneath it.

## 2. The two halves, in order

**D1 — Capture completeness.** Every activity type a grant reports on has a **live source that has
ingested a real record recently**, not just a backfilled one. This is about a record existing at all.

**D2 — Label correctness.** Every captured activity carries the fields the **four grant definitions**
actually bind to (`grant-definitions.md`). This is about the record being *usable*: an activity with no
`modality` cannot answer TC KPI 7 vs 8; a grant with no `grant_program` cannot be attributed to the TC vs
SBSH budget.

Zach: *"Once we show that we are capable of capturing all of our activity types in a reliable manner I
want to make sure we are capturing the right information and labeling the activities correctly based on
the grant definitions we have made."* D1 then D2, and neither is done by assertion — both are **measured
by a generated report** (§4).

## 3. The bar that un-shelves Sprint C

Sprint C restarts when all four are true and the generated report says so:

1. **Every one of the 7 activity types has a live source** that has ingested at least one **real**
   (non-backfill) record in the trailing 30 days.
2. **Every field the four grant definitions bind to** is populated on **100% of records created in the
   trailing 30 days** for its type. Historical blanks are allowed but must be **declared** in the report,
   never silently blank. (Design rule 3 already says an unbound column must be a declared state.)
3. **Re-delivery is `noop` across every source** — the existing `upsertActivity` contract, verified per
   source rather than assumed.
4. **The nightly ingest has completed a green run.** As of today `nightly-activities.yml` has *never*
   completed one; "ingest is live" is not yet a true statement.

Point 4 is the cheapest and it is currently the weakest link: an ingestion layer that has never run
unattended is not a reliable capture mechanism, whatever the adapters do when invoked by hand.

## 4. The instrument — `capture-coverage.ts` (build this first)

A generated, re-runnable report. Not a spreadsheet someone maintains; the whole point is that it stays
true. One row per **activity type × grant**, and per type:

- the source, and whether it is **wired** (webhook/permission present) vs merely **built**
- records total · records created in the trailing 30 days · **last real ingest timestamp**
- per-field fill rate, restricted to the fields the grant definitions bind to for that type
- a red/amber/green per the §3 bar, so "are we there yet" has one answer

This replaces `report-readiness-census.ts` as the thing to run before planning. ⚠️ That census is
**stale** — it predates the sheet import, so its "236 activities" and "only 1 of 8 KPIs is producible"
are both out of date and should not be quoted again until re-run.

## 5. Where capture actually stands (measured, 8/31 census + 9/02–9/03 changes)

| Type | Source | Wired? | Records | Verdict |
|---|---|---|---|---|
| `intake` | GHL appointment, calendar-routed | ✅ live | 73 | 🟢 capture fine |
| `technical_assistance` | GHL appointment, calendar-routed | ✅ live | 15 | 🟢 capture fine; `modality`+`service_topic` 15/15 since `c03b9a5` |
| `program_acceptance` | GHL opportunity stage | ✅ live | 84 | 🟢 |
| `grant` | GHL Direct Grant Application form | ⚠️ **webhook #2 unwired** | 63 | 🟡 records exist; **4 headline fields 0/63** → a D2 problem too |
| `metrics` | GHL Client Reporting form | ✅ **wired 9/02** | 1 live | 🟡 capture proven, history pending (227 Gateway rows built `7897666`, not yet run) |
| `introduction_referral` | this app's form at `/` (staff-logged) | ✅ live | **1** | 🔴 **the mechanism works; nobody is using it** |
| `workshop_event` | Wix Events attendance | ❌ **blocked on Wix permissions** | **0** | 🔴 **no capture at all** |

**The two reds are different problems and need different fixes.**

- `workshop_event` is a **credentials** problem, fully diagnosed in `wix-events-phase6.md`: the app's
  `WIX_API_TOKEN` can read events (47, 37 ENDED) but attendee PII comes back **anonymized** and the
  `eventId` filter is ignored, while the `wix-ghl` MCP tooling reads the same site with real names,
  emails and check-in state. Same API, different credentials. One permissions change unblocks it.
- `introduction_referral` at **1 record** is a **behaviour** problem. TC binds column P to it and its
  required KPI 16 wants **35 referrals to ecosystem partners**. No engineering fixes a form nobody opens.
  This needs a decision about how referrals get logged — see §7.

**Also true and worth stating plainly:** every ENDED Wix event reports **0 attended** because the door
check-in app is not used. So phase 6 built perfectly still reports ~zero attendees against TC KPI 3's
target of 100. That is an LRL process fix, not code, and it is the single highest-leverage non-technical
item in this sprint.

## 6. Zoom notes → appointment → activity (Zach's second thread)

> *"Grab those notes, get them on the appointment, update the appointment status (Attended or no showed),
> before we create the actual activity."*

**Decision (Zach, 9/03): write back to the GHL appointment, then let the activity ingest from it.** GHL
stays the record a human can open and understand; the activity is downstream of it, not a parallel truth.

**This is unusually ready, and the reason is a measurement already in the repo:** every appointment
carries **its own distinct Zoom meeting id** in `address` — 110 distinct ids across 110 meetings, not a
shared personal room — and `zoomMeetingId()` already extracts it. `zoom_meeting_id` is populated
**15/15** on TA activities. **The join key exists and is proven.** That was the open question in the
Sprint 5 feasibility spike; it is answered.

Sequence, and the order matters:

1. Pull the Zoom AI Companion summary for the meeting id.
2. Write it onto the **GHL appointment**, and set the appointment status to **Attended / No-showed**.
3. **Then** ingest the activity, which picks up notes and status from the appointment as it already does.

Doing it in this order means attendance is decided once, in GHL, before an activity claims it — rather
than the activity and the appointment disagreeing later.

**⬜ Measure before building:** whether appointment notes and status are actually writable via the GHL
API. **Several GHL fields accept a write, return 200, and store nothing** — so this gets the standard
treatment: write, read back, and report `skipped` rather than `applied` if it did not persist. Do not
plan the sequence around an unverified write.

**Bonus this unlocks:** `service_topic` is currently a route default rather than a per-meeting fact. A
real meeting summary is the natural source for it, which is exactly what the field was waiting on.

## 7. Right-object capture, dedup, associations (Zach's third thread)

> *"Currently we capture most things onto contact records which is fine for now, but I want to capture it
> somewhere that it would be the best… straight onto the right object records without the need for as
> many syncs. That requires good dedup capabilities and creation of the right associations."*

**The instinct is correct and it is the same root cause as the 8/27 incident.** Every sync between two
records that hold the same fact is a loop waiting for a bulk import; the 319-writes-in-7-minutes incident
happened precisely because company name lived in two places with no owner. **Fewer syncs is fewer loops.**
Capturing a fact once, on the object that owns it, removes the class of bug rather than guarding it.

**The hard constraint to design around:** GHL **forms are contact-scoped**. They cannot write to a
company or a custom object directly. So "capture straight onto the right object" cannot mean "make the
form do it" — it means **the ingestion layer becomes the thing that lands each fact on its owning record
at capture time**, with the contact as the arrival point rather than the destination. That is a real
architectural change and it is why this thread is third, not first: it re-plumbs sources that currently
work, and doing that before capture is complete risks breaking the 🟢 rows in §5.

Its two prerequisites are already named elsewhere and both are real:

- **Dedup.** `lib/dedup/engine.ts` exists, but there are **three separate company records named "Grand
  Rapids SmartZone"** plus two near-variants, with contacts spread across them. That is how a Burgess
  Institute name landed on a Grand Rapids record during the incident. Dedup is not hygiene here; it is
  the precondition for "the right object" to be a well-defined phrase.
- **Associations.** ⚠️ **Never assume which side of an association a record goes on — read the
  definition.** GHL swapped the sides on custom-object ↔ custom-object associations, and posting the
  wrong way round fails `422 Invalid record id`. Use `resolveAssociationDef(key)`. Association
  definitions are **permanent** — there is no delete — so a wrong one is forever.

**Related decision still open (carried from Sprint C):** bare-contact subjects — enrich contacts (A) or
**create a lightweight company at first service (B, recommended and provisionally taken)**. B is the same
idea as this thread: give every served party a company-shaped record with a stable dedup key, so the
funder row and the object model agree. **This thread should settle that question rather than inherit it.**

## 8. Sequence

| # | Work | Why here | Blocked on |
|---|---|---|---|
| 0 | **`capture-coverage.ts`** — the instrument | Everything else is judged by it; and the current census is stale | — |
| 1 | **Wix Events permission** → phase 6 → `workshop_event` | The largest capture hole; a credentials change, not code | **Zach** (Wix dashboard) |
| 1b | **Door check-in process at LRL** | Phase 6 without it reports ~0 attendees | **Zach / team** |
| 2 | **Webhook #2** (Direct Grant Application) | Last unwired ingest path; copy of the #3 that works | **Zach**, 5 min |
| 3 | **Nightly green run** | "Ingest is live" is not yet true | verify after `7efdb67` |
| 4 | **Run the Gateway backfill** (`7897666`) | Gives `metrics` seven real periods of history | 5 unmatched Apr-2023 rows to resolve |
| 5 | **⭐ fix 3 — grant headline fields** | D2: 0/63 on four fields TC binds to cols R/S/T | spec'd in `grant-headline-fields.md` |
| 6 | **Referral logging** — why is it 1 record? | D1: TC col P and KPI 16 (target 35) rest on it | a decision, not a build |
| 7 | **Zoom notes → appointment → activity** | Enriches the best-covered path; join key proven | measure GHL appointment writability first |
| 8 | **Right-object capture + dedup + associations** | Re-plumbs working sources; needs 1–7 stable first | dedup pass; bare-contact decision |

**Zach's hands, and nothing moves without them:** the Wix Events permission (item 1), webhook #2
(item 2), and the door check-in process (item 1b). Items 1 and 1b are the two that decide whether
`workshop_event` — the biggest hole — closes at all.

## 9. What this sprint is NOT

- **Not a cancellation of Sprint C.** The TC workbook stays the acceptance test; `grant-definitions.md`
  and the column bindings stay current and stay authoritative about which fields matter.
- **Not a coverage-percentage gate on historical data.** Standing guidance (Zach, 8/24): population
  figures are **reference**, not blockers. The §3 bar is deliberately about **new capture in the
  trailing 30 days**, because that is what "we are capable of capturing this" actually means. History is
  a separate, backfill-shaped problem.
- **Not a rewrite.** The ingestion core — `upsertActivity`, the claims ledger, the routing config, the
  write-path guards — is proven and stays exactly as it is. Every hard-won rule in `CLAUDE.md` still
  applies, especially: never bypass `upsertActivity`, and verify every write by reading it back.
