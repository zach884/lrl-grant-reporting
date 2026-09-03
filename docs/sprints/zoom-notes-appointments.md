# Brief — Zoom AI Companion notes → GHL appointment → Activity

> **Written 2026-09-03**, from **live probes of both APIs on the same day**, not from docs alone.
> Parent sprint: `sprint-d-capture-completeness.md` (item 7).
> Zach's ask: *"grab those notes, get them on the appointment, update the appointment status (Attended
> or no showed), before we create the actual activity."*
> Requirement added by Zach 2026-09-03: **"it needs to work for anyone on the team with a Zoom account
> connected to GHL"** — not just his own meetings. §3 is that requirement, and it is the whole risk.

## 1. What was measured live today

**The summaries are real, rich, and already being generated.** Pulled the actual AI Companion summary
for *"Zach Kraabel <> Aveek Das | i4.0 Accelerator"* (2026-09-02, meeting `92190173241`). It contains a
quick recap, **next steps with owners**, six sectioned summary paragraphs, both `summary_markdown` and
`summary_plain_text`, a `summary_doc_url`, and a trailing attendee line with roles
(*"Zach Kraabel (Organizer), Aveek Das (External)"*).

**Three findings that change the design:**

1. **No cloud recording and no transcript are involved.** Across 15 meetings in Aug–Sep, every one has
   `has_recording: false` and `has_transcript: false`, and almost every one has `has_summary: true`.
   `recordings_list` for the whole month returns **0 records** — that is *expected*, not a problem, and
   anyone who checks recordings first will wrongly conclude this is dead. **The summary is the asset.**
2. **The join key is confirmed on both sides.** Zoom returns `meeting_number: 92190173241`; that is the
   same numeric id `zoomMeetingId()` already parses out of the GHL appointment `address`, and it is
   already stored — `zoom_meeting_id` is **15/15** on TA activities.
3. ⚠️ **`meeting_number` is NOT unique per occurrence.** The recurring *"S&MA LVL10 Meeting"* returns
   `99387743679` for **both** 8/21 and 8/28, with different `meeting_uuid`s. So the join must be
   **`meeting_number` + the appointment's date**, resolved to a **`meeting_uuid`**, and every downstream
   read must use the UUID. Joining on the number alone will attach the wrong week's notes to a meeting
   and it will look completely plausible.

## 2. The sequence, and why the order is the point

1. Resolve the appointment's `zoom_meeting_id` + date → the Zoom `meeting_uuid` for that occurrence.
2. Fetch the summary and the participant list for that UUID.
3. **Write the note onto the GHL appointment** (`POST /calendars/appointments/:id/notes`).
4. **Set `appointmentStatus` to `showed` or `noshow`** (`PUT /calendars/events/appointments/:id`).
5. **Then** run the appointment adapter, which ingests the activity from the now-correct appointment.

**Step 4 before step 5 is not cosmetic — it fixes a live over-count.** The adapter's measured reality is
that `showed` is set on only **2 of 140** appointments, so it treats *"confirmed and the start time has
passed"* as held. **Every unmarked no-show is currently ingested as a held TA activity.**
`NON_EVENT_STATUSES` already excludes `noshow`, so the moment Zoom truth sets that status, those records
stop being created. **This is a D2 label-correctness fix, not just enrichment** — it makes TC KPIs 7/8
count meetings that actually happened.

**Attendance rule.** The adapter's own header already reasoned this out: *"`past_meetings/{id}` exists
only if the meeting actually happened, which is a far better attendance signal than the status field."*
Concretely:

| Zoom evidence | Write |
|---|---|
| meeting occurrence exists **and** a non-host participant joined | `showed` |
| occurrence exists but **only the host** joined | `noshow` |
| no Zoom occurrence at all for that id + date | **leave the status alone** — absence of evidence is not a no-show (phone/in-person meetings exist) |

⚠️ **`participants` did NOT come back on either meeting probed** (Aveek Das 9/02, Joe Marr 8/31). The
tool advertises the field; two for two, it is absent on these non-recorded meetings. **Both** summaries
did, however, end with a reliable attendee line:

```
**Attendees:** Zach Kraabel (Organizer), Joe Marr (External)
```

So today the only observed attendance signal is **prose at the end of the markdown**, which is a fragile
thing to parse and a bad thing to depend on. ⬜ **Before building attendance, establish a real source:**
try `GET /past_meetings/{uuid}/participants` on the app's own S2S credential (a different endpoint from
what this connector exposes, and the one the adapter's header always assumed). If that returns real
participants, use it and ignore the prose. **If neither yields structured participants, ship notes
without attendance** rather than parsing an AI-written sentence into a `noshow` that suppresses a
funder-reportable activity. Wrong `noshow` = a real meeting silently deleted from the grant count.

## 3. 🔴 THE RISK: it must work for the whole team, and that is the part Zoom may not allow

**Measured today, and it is exactly the constraint Zach named.** In the same result set:

| Meeting | Host | `has_summary_permission` |
|---|---|---|
| S&MA LVL10, i4.0 Touch Base, Aveek Das, Joe Marr, Signal-Wise … | **Zach** | ✅ `true` |
| "Brandon Marken's Zoom Meeting" | Brandon | ❌ **`false`** |
| "AGS><Harvest Solar Updated" | Sierra Sibson | ❌ **`false`** |

**A user-level token only reaches meetings that user hosted.** When a team member's GHL calendar link
books a meeting, *that member* is the Zoom host — so a Zach-scoped credential would silently return
nothing for their meetings. Not an error; just no notes and no attendance, on exactly the appointments
the grants care about.

**Team coverage therefore requires an account-level (admin) credential** — and this is where it may
snag. Zoom's own developer forum has open threads **into 2026** reporting that the summary admin scopes
(`meeting_summary:read:admin`, `meeting:read:summary:admin`) **do not appear in the Server-to-Server
OAuth scope picker**, and that requesting them yields *"Invalid access token, does not contain scopes"*.
Reported workarounds: `GET /v2/meetings/meeting_summaries` (list) works, and the summary body reads from
the endpoint **without** the `/accounts/{accountId}` master segment.

> ### ⬜ DO THIS FIRST — a 30-minute spike, before any code
> 1. In LRL's Zoom account, create a **Server-to-Server OAuth** app.
> 2. **Look for the summary admin scopes in the picker.** Whether they are there decides the whole design.
> 3. Call `GET /v2/meetings/meeting_summaries` for a date range and check it returns meetings hosted by
>    **someone other than Zach** — that single assertion is the team-coverage test.
> 4. Then fetch one summary body by UUID.
>
> **If the admin scope is unavailable, say so plainly rather than building a Zach-only version.** The
> fallbacks, in preference order: (a) a Zoom **Marketplace/user-level OAuth app that each staff member
> authorizes once**, storing a per-user refresh token keyed to their GHL user id — more setup, but it is
> genuinely per-team-member and does not depend on the missing admin scope; (b) Zoom support/admin
> enablement of the scope on the account; (c) ship it Zach-only and declare the coverage gap in
> `capture-coverage.ts` rather than leaving it invisible.
>
> **Note which account is being tested.** The connector used for today's probe is a Claude-session
> connector on Zach's identity. It proves the *data* exists and is good; it proves **nothing** about
> team-wide API access, and it is not something the deployed app can call (§5).

## 4. The GHL write side — endpoints confirmed, with three traps

**Notes** — `POST /calendars/appointments/:appointmentId/notes`, body `{ userId, body }`, response 201
with `note.id`.

- 🔴 **`body` is capped at 5,000 characters, and real summaries already exceed it.** Measured on two
  meetings: Aveek Das (2 people, 15 min) ≈ **3.9k — fits**; **Joe Marr (2 people, 28 min) ≈ 8k — does
  not**, at roughly 1.6× the cap, with a recap, 4 next steps and 8 sections. A one-hour group session
  will be worse. **So truncation is the normal case, not the edge case.**
  **Rule: write `## Quick recap` + `## Next steps` verbatim, then a link to `summary_doc_url`** for the
  sectioned body. Those two blocks are the part a staffer actually re-reads, they are first in the
  document, and they fit comfortably. Never hard-cut at 5,000 — it would sever a next step mid-sentence.
- ⚠️ **A note is its own resource with its own id, and `Create` appends.** Running this twice creates a
  second note, forever — the same shape as the multi-select bug that rewrote 57 referral records on
  every run. **There must be a `noop` path:** record the note id (claims ledger, keyed like every other
  source) and use `Update Note` on re-run. A write path that cannot report `noop` is broken.
- `userId` should be the **assigned GHL user**, so the note is attributed to the staffer who ran the
  meeting rather than to a service account.

**Status** — `PUT /calendars/events/appointments/:eventId`, `appointmentStatus` ∈
`new · confirmed · cancelled · showed · noshow · invalid · completed · active`.

- 🔴 **`toNotify` defaults to `true` — "if set to false, the automations will not run."** Updating a
  status with the default therefore **fires GHL workflows**, including the appointment webhook, which
  re-ingests the activity. That is the 8/27 incident's shape in miniature. **Always send
  `toNotify: false`.**
- ⚠️ **The PUT body also carries `calendarId`, `startTime`, `endTime`, `title`, `address`.** Whether
  omitted fields are preserved or cleared is **unverified**, and this is precisely the class of bug that
  `writeRecordFields` taught: *the caller must diff.* **Probe on a throwaway appointment** — send only
  `{appointmentStatus, toNotify:false}`, then read the appointment back and confirm the time, title and
  address survived. Do not run this against a real client booking until that is proven.
- **Verify by reading back**, and report `skipped` rather than `applied` if the value did not persist.
  Several GHL fields accept a write, return 200 and store nothing.

## 5. Where this runs — the app needs its own Zoom credentials

`.env.local` currently holds no `ZOOM_*` anything. The connector used for today's probe is a
Claude-session tool and **the deployed Vercel app cannot call it**. Sprint D's bar requires *"a live
source that has ingested a real record in the trailing 30 days"*, so a human running a Claude session
does not clear it.

So: a Zoom app of our own, with `ZOOM_ACCOUNT_ID` / `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` in
**`.env.local`, Vercel, *and* GitHub Actions secrets** — all three. ⚠️ Two hazards already on record:
the nightly workflows died for two runs on a bare `readFileSync('.env.local')` that does not exist on a
GitHub runner, and a stale `WIX_API_TOKEN` secret broke a nightly on 9/01. Same trap, twice.

**Trigger: extend the existing nightly.** Poll `GET /v2/meetings/meeting_summaries` over a trailing
window inside `nightly-activities.yml`, ahead of the appointment adapter so the ordering in §2 holds.
Zoom does emit a summary-completed webhook, and it is the better long-run answer, but the nightly job
already exists and summaries are not time-critical. ⚠️ That workflow has **never completed a green run**
— fix that first, or this ships onto a runner that does not run.

## 6. Build order

| # | Step | Output |
|---|---|---|
| 0 | **Zoom S2S app + the team-coverage assertion (§3)** | a yes/no that decides the design |
| 1 | **GHL write probes on a throwaway appointment** | does a partial `PUT` preserve the other fields; does `toNotify:false` suppress automations; does a note persist |
| 2 | `meeting_number` + date → `meeting_uuid` resolver | correct occurrence for recurring meetings |
| 3 | Attendance signal chosen on evidence (participants vs the summary's attendee line) | measured across ~20 meetings |
| 4 | Note writer with an idempotent update path + claims row | re-run reports `noop` |
| 5 | Status writer with `toNotify:false`, diffed and read back | never rewrites an unchanged status |
| 6 | Wire into the nightly **before** the appointment adapter | ordering per §2 |
| 7 | Backfill across the ~110 appointments carrying a Zoom id | dry-run → review → apply |

## 6b. 🔴 The summary MISATTRIBUTES SPEAKERS — treat it as prose, not as data

Found in the Joe Marr summary, and it matters more than it looks. Two sections attribute Zach's
statements to Joe:

- *"Joe mentioned that Lean Rocket Lab has been operating for 4-5 years with a background in data
  analytics"* — the 4–5 years is LRL, the data-analytics background is **Joe's company**; two facts
  about two organizations welded into one sentence.
- A whole section titled *"Lean Rocket Lab Market Shift"* opens *"Joe explained that Lean Rocket Lab has
  shifted its target market…"* — **that was Zach explaining LRL's own programs.**
- The *"$30,000 to $150,000"* project range is **Joe's consulting pricing**, sitting in a section whose
  framing invites reading it as LRL's.

**Consequence for the design.** As **human-readable notes on an appointment**, this is excellent and
should ship — a staffer reading it gets the meeting back instantly, and small attribution slips are
obvious to someone who was there. As a **source of structured facts**, it is not trustworthy: any
pipeline that parsed dollar figures, org attributes or program names out of this text would have
recorded Joe's pricing as an LRL fact with full confidence and no error.

**So: notes onto the appointment, yes. Deriving structured fields from summary prose, no** — and that
directly tempers §7 below. It also argues the note should carry a visible provenance line
(*"AI-generated Zoom summary — may misattribute speakers"*) so nobody downstream mistakes it for
staff-authored minutes.

## 6c. The summary is a LABELLING check, which is the D2 half of the sprint

The Joe Marr meeting is a good example precisely because **it is not technical assistance.** Joe is a
consultant exploring running workshops for LRL — a partner/vendor conversation. If it were booked on a
routed calendar it would ingest as intake or TA and quietly become a funder-reportable row for a company
LRL did not serve.

That is exactly the hazard `activity_routes` already guards by design — *"a source with no rule ingests
NOTHING — deliberate: personal calendars are used for vendor and partner calls."* The summary makes the
guard **auditable**: it is the first artifact that can tell you, after the fact, whether a routed meeting
was really the activity type its calendar claims.

**Worth doing, and cheap:** once notes are landing, run a review pass that flags activities whose summary
reads like a partner/vendor conversation rather than service delivery. **Flag for human review — never
auto-reclassify**, given §6b. A mislabelled row is the failure mode Sprint C's acceptance test would
catch far too late, and the one Zach named when he said the labelling has to be right.

## 7. The bonus worth naming

`service_topic` is currently a **route default** — inherited from which calendar was booked, identical
for every meeting on that link. A real meeting summary is the natural per-meeting source for it, and
that was always the field's intended eventual source. Once summaries land, `service_topic` could become a
`derivedFrom` value over the summary text (recomputing, individually overridable) exactly like the
readiness tagger.

**⚠️ Tempered by §6b.** The summaries misattribute speakers, so a derived `service_topic` must be
treated as a **suggestion routed to review**, not a fact written straight onto a funder-reportable
record — at least until a batch of them has been checked by hand against meetings someone remembers.
A route default that is bluntly wrong in a known way is safer than a derived value that is subtly wrong
in an unknown one.

**Do not do this in the same pass.** Land notes first, prove `noop`, settle attendance, then derive.
