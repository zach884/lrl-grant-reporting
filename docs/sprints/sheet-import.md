# Importing the workflow-written spreadsheets

> **Status 2026-08-31: measured and designed. The dedup question is answered by the data.**
> Sources: `Past Grant Reports/Trusted Connector Report.xlsx` (sheet `Cumulative Reporting`) and
> `SBSH Companies Served Spreadsheet (1).xlsx` (sheet `Sheet1`) — the live logs Zach's GHL workflows
> append to, not the reformatted funder submissions. i4.0 not exported yet, and it is last anyway
> because its history lives in a different GHL sub-account.

## Why this import matters more than it looks

**The TC sheet holds 271 one-on-one TA rows. GHL holds 15.** Appointment-based capture only ever sees
sessions booked through routed GHL links; most ran on other links (whose workflow writes the sheet) or
on Google Calendar. So the sheet is not a nice-to-have backfill — it is most of LRL's technical
assistance history, and TC's required KPI 7 is uncomputable without it.

## One row is one activity — the flags already separate them

Zach's concern (8/31) was that several activity types collapse into the sheet's "1:1 Technical
Assistance" column, and that date alone can't tell an intake from a referral made the same day. The
first half is true; the second isn't, because **rows are single-type**:

| Flag combination on a row | Rows |
|---|---|
| `1:1 TA` only | 253 |
| `Referral` only | 65 |
| `Group TA` only | 39 |
| `1:1 TA` + `Grant` | 11 |
| `1:1 TA` + `Group TA` | 7 |

An intake and a referral on the same day are two rows with different flags, so they never need
disentangling. What DOES need disentangling is what sits inside the 1:1 TA column.

## The notes carry the appointment title verbatim — that's the classifier

Zach's guess was that notes reference the intake link or event title. They do, literally:

```
Intake Meeting with Jay Mitchell | want to...          → intake
Intake Meeting with Robert Bulloch | ...              → intake
 Tyler Scott | Check-In with Lean Rocket              → technical assistance (session)
Sent SCORE Startup Road Map & Pro Forma template      → technical assistance (advice)
Referred her to Michigan Tribe, sent her our LLC...   → technical assistance (advice)
```

Classifying the 271 rows on the notes text:

| Resolved type | Rows |
|---|---|
| `intake` (notes say "Intake Meeting") | **84** |
| `technical_assistance` — unclassified prose | 149 |
| `technical_assistance` — advice / resource-sending | 23 |
| `technical_assistance` — named session (check-in, coaching) | 15 |

**Validation against GHL, not just pattern-matching:** of the 80 in-range rows whose notes mention
intake, **63 have a GHL intake activity on the exact same date** (79%). The classifier agrees with
independently-captured data, which is the only reason to trust it.

Note the 149 "unclassified" are not a failure — read them and they are genuinely technical assistance
(sending templates, making introductions, advising on entity setup). TA is the correct default for a
1:1 TA row whose notes don't name a meeting.

## The dedup rule: (company, date, resolved type)

This was the open decision. The data settles it — matching on company + date + resolved type
identifies the overlap almost perfectly, and the overlap is small:

| | Rows | Already in GHL same company+date | Net new |
|---|---|---|---|
| Rows the notes call **intake** | 84 | **63** | 21 |
| Rows that resolve to **TA** | 187 | 14 | **173** |
| | **271** | 77 | **≈194** |

So a company+date+type skip rule keeps 194 genuinely-missing activities and rejects the 77 that would
double-count. Importantly the collision is concentrated exactly where you'd expect — intake, the one
type GHL already captures well — which is corroboration that the rule is measuring something real.

Company resolution is healthy: **232 of 271 rows (86%) match an existing GHL company** by normalized
name; 39 don't and need either a company created or the bare-contact path.

**48 rows are pre-2026**, where GHL has no coverage at all, so those are safe by construction and
need no matching — a good first slice to import and verify before touching 2026 rows.

## Identity, so a re-import is a noop

`(source: 'Sheet Import', sourceRecordId: 'tc-cumulative:row-<N>')`.

Row number is stable because these sheets are **appended** by a workflow, never re-sorted. It is
deliberately not a content hash: someone editing a note six months from now must not orphan the
activity and create a second one. The trade-off is that inserting a row mid-sheet would shift keys —
worth a note in the runbook, and detectable by storing the row's business name alongside the key and
warning when they disagree.

## Open, for Zach

1. **The 39 unmatched companies** — create company records, or attach to the bare contact (his 8/24
   rule allows a contact with no company)?
2. **`Reason for grant` is polluted** — several rows contain an AI failure message rather than a
   reason ("The passage directs you to generate a very short description…"). Those should import as
   blank, not as the error text. Worth fixing at the workflow source too.
3. **The 2025-09-30 batch** — 11+ rows share that date with notes describing what was sent. That looks
   like a bulk catch-up entry rather than eleven meetings held that day. Import as-is, or date them
   differently?

## What the sheet says about events — and what it can't

`Hosted a Tech or Innovation event` and `Networking or mentorship initiative` are **false on all 375
rows**. Neither has ever been logged, anywhere. So TC's required KPI 3 (attendees at tech/innovation
events) and KPI 6 (networking/mentorship initiatives executed) cannot come from this import at all —
they can only come from Wix events (phase 6).

Zach on how those buckets are decided (8/31): *"We don't really keep track of Innovation Events
specifically. We typically just count up how many events we ran overall. If the event is
tech/innovation topic focused then it counts for that bucket, if it is more networking or mentorship
driven it goes in the other."*

So `event_type` is a **topic judgement per event**, not a field anyone maintains — which resolves the
open question in `wix-events-phase6.md`. With 47 Wix events it is a one-time classification pass over
the title and description, the same shape as the readiness tagger: AI proposes, stored as a
`derivedFrom` value so it recomputes if the event text changes, and reviewable before it counts.
Two buckets only: tech/innovation, or networking/mentorship.
