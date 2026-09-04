# Brief — Zoom AI Companion notes → GHL appointment → Activity

> **Written 2026-09-03**, from **live probes of both APIs on the same day**, not from docs alone.
> Parent sprint: `sprint-d-capture-completeness.md` (item 7).
> Zach's ask: *"grab those notes, get them on the appointment, update the appointment status (Attended
> or no showed), before we create the actual activity."*
> Requirement added by Zach 2026-09-03: **"it needs to work for anyone on the team with a Zoom account
> connected to GHL"** — not just his own meetings. §3 is that requirement, and it is the whole risk.

## 0. Scope, and how to prove it out

**Scope (Zach, 2026-09-03):** *"get meeting notes/summary for all zoom meetings scheduled with GHL
Appointment links."* So **the GHL appointment list is the driver, not the Zoom meeting list.** We already
fetch appointments; each one that carries a Zoom id in `address` is a row to enrich. Meetings with no GHL
appointment are out of scope entirely. That simplifies things — no Zoom-side sweep, no reconciliation of
two lists, and the unit of work is one we already have an id for.

**Also settled:** the summary is what decides `showed` / `noshow` (§2).

### A — Zach's hands: the Zoom app (~30 min, needs Zoom account admin)

> 🔴 **HIT 2026-09-03: "Server-to-Server OAuth" is GREYED OUT in Zach's developer portal.**
> This is a **role permission**, not a missing feature and not a billing problem. Creating an S2S app
> requires being the Zoom **account owner**, an **account admin**, or holding the **"Zoom for
> developers"** role privilege.
>
> **The unlock — done by the account OWNER, in the Zoom web portal:**
> `User Management → Roles → Role Settings → Advanced features → "Zoom for developers"` →
> tick **both View and Edit**. Then sign out of the Marketplace and back in; the option becomes
> selectable.
>
> ⚠️ **Reported repeatedly on Zoom's own forums: users who already hold an admin role still cannot see
> Roles / Role Settings, and the account OWNER has to make the change.** So the first question is
> literally *who owns LRL's Zoom account* — if it is not Zach, this is a request to that person, and it
> is one sentence long.
>
> **If the owner cannot or will not enable it, this is a design fork, not a delay** — go to the
> per-user OAuth fallback in §3, which is more setup but is arguably the better answer to "anyone on the
> team" anyway, since each staffer grants access to their own meetings and it does not depend on the
> admin summary scopes that Zoom's forums report as missing.

1. Zoom Marketplace → **Develop → Build App → Server-to-Server OAuth**. Note **Account ID**, **Client
   ID**, **Client Secret**.
2. **Add scopes.** Ask for these, in this order — the first two are the ones reported missing:
   - `meeting_summary:read:admin` *(or the newer `meeting:read:summary:admin`)* — the summary body
   - `meeting:read:admin` — meeting + past-instance lookup
   - `report:read:admin` *(or `dashboard_meetings:read:admin`)* — participants, the attendance fallback
3. 🔴 **The one assertion that decides the design.** Call
   `GET /v2/meetings/meeting_summaries?from=2026-08-01&to=2026-09-03` and check the response contains a
   meeting **hosted by someone other than Zach**. That is the whole team-coverage test from §3.
   - **Passes** → build as specified.
   - **Fails, or the scopes aren't in the picker** → stop and pick a fallback from §3 before writing code.
     Do not quietly ship a Zach-only version.

### B — One read-only spike script, zero writes (`scripts-ts/zoom-probe.ts`)

Everything here is measurement. It must not write to GHL or Zoom.

| # | Measure | Pass bar |
|---|---|---|
| 1 | **Coverage** — of past GHL appointments in the last 90 days, how many carry a Zoom id, and how many resolve to a real Zoom occurrence? | ≥90% of Zoom-linked appointments resolve. Below that, find out why before building |
| 2 | **Host spread** — how many resolve for hosts *other than Zach* | >0, or §3 has failed |
| 3 | **Attendance signal** — for each match, does `GET /past_meetings/{uuid}/participants` return real participants, and does the summary footer list an `(External)` attendee? | pick whichever is present ≥95% of the time |
| 4 | **Note length** — distribution of `summary_plain_text` and of `recap + next steps` alone | confirms the §4 truncation rule holds across real meetings, not just the two probed |

**The resolver, with the traps:** `address` → meeting number → `GET /v2/past_meetings/{number}/instances`
(returns every ended instance with its UUID) → pick the instance whose start time matches the
appointment's date → use that **UUID** for everything downstream.
⚠️ **A UUID that starts with `/` or contains `//` must be DOUBLE URL-encoded**, or Zoom answers
*"Meeting does not exist"* — a wrong-looking error for a right-looking id.

### C — One GHL write probe, on a throwaway appointment (`scripts-ts/ghl-appointment-write-probe.ts`)

Create a test appointment on a test calendar, then, reading back after every step:

1. `POST /calendars/appointments/{id}/notes` → does it persist; capture `note.id`.
2. `Update Note` with that id → does it update in place rather than adding a second note.
3. `PUT /calendars/events/appointments/{id}` sending **only** `{appointmentStatus:'showed', toNotify:false}`
   → **then GET the appointment and confirm `title`, `startTime`, `endTime`, `address` and `calendarId`
   all survived.** This is the `writeRecordFields` lesson: assume nothing about partial updates.
4. Confirm `toNotify:false` really suppressed automations — no appointment webhook delivery, no
   `change_log` row from a re-ingest.
5. Re-run 1–3 unchanged → everything reports **`noop`**.

### D — What "proven" means

All of: the team assertion in A passes · ≥90% appointment→meeting resolution · one attendance signal is
reliably present · a partial `PUT` preserves the other fields · `toNotify:false` fires no automation ·
and a second identical run writes nothing. **Only then** wire it into the nightly ahead of the
appointment adapter.

---

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

**Zach's call: the summary decides it.** A summary only exists for a meeting that actually ran, and its
footer names who was in it — so summary-plus-external-attendee is direct evidence the client showed.

| Zoom evidence | Write |
|---|---|
| occurrence exists **and** a non-host / `(External)` attendee is present | `showed` |
| occurrence exists but **only the host** appears | `noshow` |
| **no Zoom occurrence at all** for that id + date | **leave the status alone** |

**The third row is the safety rule and it should not be softened.** No Zoom occurrence can mean the
client no-showed — or that the meeting moved to a phone call, ran in person, or used someone's personal
room. Writing `noshow` on absence of evidence would push the activity into `NON_EVENT_STATUSES` and
**silently delete a real, funder-reportable meeting from the grant count.** Wrong `showed` is a bad row
someone can spot; wrong `noshow` is a row that never appears. Leave those for a human, and surface them
to `sync_review` rather than letting them sit invisible.

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
already exists and summaries are not time-critical.

✅ **CLEARED 2026-09-04 — the runner is healthy.** This brief said the workflow had never completed a
green run; that was true when written and is not any more. Checked against the Actions API:

```
nightly-activities   #5 2026-09-04 success   #4 09-03 success   #3 09-02 success (dispatch)
                     #2 09-02 failure        #1 09-01 failure
```

Run #5's own output — `appointments: 2 noop, 2 skip:cancelled` and `opportunity stages: 147 noop,
176 skip:no-route` — is a clean all-noop night, so it is genuinely doing the work rather than exiting
0 early. `nightly-resources` recovered the same way; `square-netsales` failed only its 09-01 scheduled
run, was fixed by dispatch the same day (#5, #6 green) and then hardened with a credentials preflight.
**Nothing is blocking this brief from the runner side.**

⚠️ **But the schedule comments in every workflow are fiction.** GitHub defers scheduled runs on this
repo by a consistent **~4–4.5 hours**:

| Workflow | cron | actually starts |
|---|---|---|
| nightly-score | 06:30 | ~11:33 |
| nightly-reconcile | 07:00 | ~11:54 |
| nightly-enrich | 08:00 | ~12:29 |
| nightly-readiness | 08:30 | ~12:48 |
| nightly-resources | 08:45 | ~12:55 |
| nightly-activities | 09:15 | ~13:31 |

**The relative ORDER survives**, which is what the dependencies actually need — reconcile still
finishes ~1h35m before activities starts, and activities takes ~4 minutes. So this is not a bug to
fix, but do not add a Zoom step on the assumption it runs at 5am EDT: it runs mid-morning, and a
summary generated during a 9am meeting will not be picked up until the next day. If same-day capture
matters, that is the argument for the summary-completed webhook over the nightly.

## 6. Build order

Steps 0–2 are the proof plan in §0; nothing below them starts until §0.D is met.

| # | Step | Output |
|---|---|---|
| 0 | **Zoom S2S app + the team-coverage assertion** (§0.A) | a yes/no that decides the design — **Zach** |
| 1 | **`zoom-probe.ts`** — read-only coverage, host spread, attendance signal, note length (§0.B) | the four measurements |
| 2 | **`ghl-appointment-write-probe.ts`** on a throwaway appointment (§0.C) | partial-PUT safety, `toNotify`, `noop` |
| 3 | Note writer: recap + next steps + doc link, idempotent via a stored `note.id` | re-run reports `noop` |
| 4 | Status writer with `toNotify:false`, diffed and read back, never on absent evidence | never rewrites an unchanged status |
| 5 | Wire into the nightly **before** the appointment adapter | ordering per §2 |
| 6 | Backfill across the appointments carrying a Zoom id | dry-run → review → apply |

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

## 6c. ❌ A CORRECTION, and the lesson in it

**An earlier draft of this brief called the Joe Marr meeting a "partner/vendor conversation, not
technical assistance," and said it should not become a funder-reportable row. That was wrong.**
Zach, 2026-09-03: *"This is still an intake meeting with a MI small business. They didn't fill out an
intake form so it isn't perfect."* Joe runs a Michigan data-analytics and AI consulting business; a
first conversation with a Michigan business owner **is an intake**, whether or not a form followed, and
it belongs in the count.

**The mistake is worth recording because of how it happened.** The summary's framing — a consultant
proposing workshops — invited the reading "he is a vendor to LRL." That is precisely the §6b failure
mode: drawing a structured conclusion from AI-written prose that flattens who-was-who. **The check that
was being proposed as a safeguard fell to the exact bias it was meant to catch.**

**So the rule tightens rather than loosens.** The summary is **human context on an appointment**. It is
not a classifier, and it is not evidence for or against an activity's type. A "does this look like real
service delivery?" review pass is **removed from this brief** — the calendar route and the staffer who
booked it are better authorities on what a meeting was than a paragraph written about it afterwards.

**The one place the summary does carry structured weight is attendance** (§2), and that rests on the
Zoom-generated attendee footer, not on the AI's prose.

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
