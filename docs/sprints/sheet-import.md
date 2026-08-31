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

## The reliable signal is the "|" in the notes, not the date

Zach (8/31), on a 27-row day: *"We do have very busy days but 11 is a lot of intakes."* Correct
instinct, and the data gives a sharper discriminator than cluster size.

**136 of 375 rows carry the appointment-title separator `|`** — e.g.
`Intake Meeting with Jay Mitchell | want to…`. Those are workflow rows written from a real
appointment, so their date and type are trustworthy. They spread over 63 distinct dates, at most 10
on any one day.

The 7 dates carrying ≥10 rows account for **139 rows (37%)**, and they split cleanly:

| Date | Rows | Notes name a meeting | Notes blank | Verdict |
|---|---|---|---|---|
| 2025-09-30 | 27 | **0** | 13 | batch entry — quarter end |
| 2025-12-31 | 22 | **0** | 2 | batch entry — year end |
| **2026-01-28** | 10 | **10** | 0 | **a genuinely busy day** |
| 2026-02-06 | 18 | 2 | 1 | mostly batch |
| 2026-02-20 | 23 | **0** | 0 | batch entry |
| 2026-02-24 | 20 | 1 | 0 | mostly batch |
| 2026-05-22 | 19 | **0** | 0 | batch entry |

So cluster size alone would have thrown away 2026-01-28, which was ten real titled meetings. The
title marker separates them. And the two largest batches fall on **quarter end and year end**, which
is what a reporting catch-up looks like.

The 2025-09-30 rows confirm it from the other direction: 13 of 27 have no notes at all, five are the
same company repeated (Peabody Lane Books), and four are named `Unsure` or `Unknown`.

### Wednesdays corroborate the classifier

Zach (8/31): *"Intake meetings are always on Wednesdays. Referrals are all over the place."* That is a
free, independent check on the notes-based classification — and it holds:

| Day of week for the 84 rows whose notes say "Intake Meeting" | |
|---|---|
| **Wednesday** | **80** |
| Friday | 2 |
| Thursday | 1 |
| Monday | 1 |

95%. Two independent signals — the appointment title in the notes, and the day of the week — agree,
which is the strongest evidence available that the classifier is reading real intake meetings rather
than pattern-matching noise. The four exceptions are worth an eyeball, not a rule.

It also gives a date-repair option for batch-entered intake rows (snap to the nearest Wednesday), but
Zach's call (8/31) is that **approximate dates are acceptable for history that has already been
reported**, so that stays available and unbuilt. Likewise the idea of scraping calendars for intake
dates and email for referral dates — noted, not needed.

**Import rule, therefore:**

| Row shape | Count | Treatment |
|---|---|---|
| Notes contain `\|` — appointment-derived | **136** | Full confidence. Date and type from the title |
| No title, attributable company | ~232 | Import with an **approximate-date** flag, exactly as the 52 program-acceptance records already are |
| Business Name is `Unsure` / `Unknown` / `N/A` | **7** | Skip — no attributable company |
| No email and no notes | **1** | Skip |

## Resolve the company by EMAIL, never by name — only 9 businesses actually need creating

An earlier pass matched companies by normalized name and reported 39 unmatched rows. Zach checked the
examples and found some of them **do** have company records, which was correct: name matching was
producing false negatives. Re-resolved using the house rule the appointment adapter already follows —
email → contact → `contact.businessId`:

| Over all 375 TC rows | |
|---|---|
| `email → contact → businessId` | **345** |
| name match (fallback) | 17 |
| email finds a contact, but it has no company | 9 |
| nothing resolves | 4 |

So **13 rows / 9 distinct businesses** genuinely need a company record — not 39. The three examples
show exactly why names failed:

| Sheet row | GHL company | Why the name missed |
|---|---|---|
| Chem Clean Treatment Services | **ChemClean Treatment** | no space, and "Services" dropped |
| Prescription Earth Acupuncture + Herba… | Prescription Earth Acupuncture + Herbal Medicine | truncated in the sheet |
| Jessie's Bookkeeping Solutions | **Bailey & Co** | ⚠️ *different business entirely* |

**Never match these sheets on company name.** Email is the reliable key, and it is also what every
other adapter uses, so the importer inherits the same behaviour for free.

⚠️ **But that third row is a warning, not a win.** The email resolves to a contact whose `businessId`
points at *Bailey & Co* while the sheet says *Jessie's Bookkeeping Solutions*. One of the two is
wrong — either the contact is linked to the wrong company, or the person has changed business. This is
the same class of problem `lib/sync/identityGuard.ts` exists for, so the importer should apply the
same comparison: **when the sheet's business name and the resolved company disagree beyond a fuzzy
tolerance, flag for review rather than silently attaching the activity to the wrong company.**
Attaching service history to the wrong business is a reporting error no reviewer would catch.

The 9 businesses needing records: Heart Flo Yoga · The Frame Studios · Carrie Joers - Self Employed ·
Engraved F0r You · SheVinci · Tip Top Restaurant · Blue Entity, LLC · Machine Ai Solutions LLC ·
Fizzy Aquatics LLC. The sheet row carries Business Name, Street Address, City, ST, Zip, County, Owner
Name and Email, so creating them from the sheet is straightforward — and *Carrie Joers - Self
Employed* is a good example of the bare-contact case Zach described on 8/24.

## Why `Reason for grant` contains AI failure text

Zach (8/31): *"Reason for grant was originally supposed to be calculated from a GHL workflow with a
ChatGPT step that read the line items on a contact and made a determination of what the grant was
for."*

That explains it, and it is a **timing bug, not a prompt bug**. The step fires while the contact's
expense line items are still blank, so the model correctly reports it has nothing to summarise — and
that apology gets stored as the reason. It matches what the grant analysis found independently: line
items are filled and approved during review, *after* the application arrives.

The fix is the same trigger the grant snapshot needs: run that step at **agreement execution**, when
the line items are final and the contract has just merged them. Until then, the importer treats any
`Reason for grant` matching the failure shape (mentions "line item" and "blank"/"cannot"/"please
provide") as empty rather than importing the apology as data.

## Open, for Zach

1. ~~The unmatched companies~~ — **RESOLVED:** resolve by email, and only **9** businesses need a
   company record (listed above). Create them from the sheet's firmographics.
2. ~~The untitled rows~~ — **RESOLVED (Zach, 8/31):** approximate dates are fine for history already
   reported. Import with the approximate-date flag. Catch-up rows are Alex writing up meeting notes
   after the fact, which is normal practice, not a data fault.
3. **Fix the ChatGPT step's trigger** so `Reason for grant` computes at agreement execution rather
   than at application. Separate from this import, but the same root cause as the grant snapshot.
4. **⚠️ NEW — the name/company disagreements.** Rows where the sheet's business name and the
   email-resolved company differ (Jessie's Bookkeeping Solutions → Bailey & Co) need a review pass
   before import, because attaching history to the wrong business is invisible afterwards.

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
