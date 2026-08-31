# Phase 6 — Wix events → Workshop/Event activities

> **Status 2026-08-31: DESIGN SETTLED, BLOCKED ON WIX API PERMISSIONS.**
> The app's Wix credentials can read events but not attendees. Everything else is ready.

## What Zach wants (8/29)

> *"For Event registrations in Wix I want to create Activities in GHL with the event information and
> I want to associate these essentially as tickets to the contacts in GHL. Then we can also mark
> these as registered vs. attended."*

So: **one activity per registration**, not per event. The activity IS the ticket. `registered` and
`attended` are separate flags on it, and attendance arrives later than registration — Wix Events has a
check-in app used at the door, so the flag is only knowable after the event date.

This also covers **group technical assistance**: Zach confirmed (8/29) that "TA Group for now is like
workshops that we run", and workshops live in Wix Events. So `workshop_event` feeds two different
funder metrics, split by `event_type`:

| `event_type` | Feeds |
|---|---|
| `Workshop` | TC required **KPI 8** — businesses supported through small group technical assistance |
| `Tech/Innovation Event` | TC required **KPI 3** — attendees at technology and innovation events |

## The Wix API, as measured (not from docs)

Probed live 2026-08-31 with the app's own `WIX_API_TOKEN`. Recording this because the shapes are not
guessable and two of them cost real time.

**✅ Events list — works.**
```
POST /events/v1/events/query
body: { limit: 20, offset: 0 }        ← PAGING IS TOP-LEVEL
```
⚠️ **The paging gotcha.** Nesting it the documented-looking way — `{query:{paging:{limit,offset}}}` —
returns `{total: 47, offset: 0, limit: 0, events: []}`. It reports the true total, echoes `limit: 0`,
and silently returns nothing. It looks like an empty site rather than a malformed request. Three
variations failed this way before the flat shape worked.

47 events readable, 37 `ENDED`. Each carries `id, title, slug, status, scheduling, location,
description, categories, registration`, which is everything the activity's event fields need.

**⚠️ RSVPs — reachable but unusable.**
```
POST /events/v1/rsvp/query
body: { limit: 5, offset: 0, eventId: [id] }
→ { total: 35, rsvps: [{ id, eventId, contactId, memberId, firstName, lastName,
                         email, status, totalGuests, guests, anonymized }] }
```
Two problems, both fatal for ingestion:
1. **The PII is anonymized.** `email` and `firstName` come back as empty strings and the row carries an
   `anonymized` flag. Without an email there is no way to match the registrant to a GHL contact, which
   is the whole join.
2. **The `eventId` filter is ignored** — every event returns the same global `total: 35`, so the query
   cannot be scoped to one event.

**❌ Ticketed orders — not reachable at all.** `/events/v1/orders/query`, `/events/v2/orders/query` and
`/events/v2/rsvp/query` all 404. Most LRL events are `TICKETING`, so this is the majority of
registrations.

## Why this is a permissions problem, not an endpoint problem

The `wix-ghl` MCP tooling reads exactly what the app cannot — real names, emails, ticket types, and
check-in state:

```
# Registrations for "Beyond the Basics of Quickbooks with Lally Group" (Ticketed)
Showing 1 of 1 — 0 attended, 1 registered only
### Joe Natter — Registered
- Email: sheila.natter@comcast.net    - Ticket: General Admission
```

Same site, richer access. So the difference is credentials, not the API. **The app's `WIX_API_TOKEN`
needs Wix Events permissions added** — read access to attendees/orders/RSVPs including contact
details. That is a permissions change on the API key in the Wix dashboard, and it is the only thing
standing between here and a built adapter.

*(Note: event ids differ between the two paths — the MCP reports `41cfe829…` for "Grow Your Profit"
where the app's API reports `af06af13…`. Whichever the adapter uses becomes half of the idempotency
key, so it must be consistent forever once chosen. Prefer the app's own id, since the app is what
will run nightly.)*

## Design, ready to build once unblocked

**Identity.** `(source: 'Wix Attendance', sourceRecordId: '<eventId>:<registrationId>')`. Keyed on the
registration, not the contact, so a person who registers for two events gets two tickets and a
re-sync of either is a `noop`. Using the registration id rather than the email also survives someone
correcting their email.

**Two-phase, because attendance is late.**
1. *On registration* — create the activity with `registered = Yes`, `attended` left blank. Not `No`:
   blank means "not yet known", `No` means "checked in nobody". Conflating them would make an
   un-checked-in event look like a measured zero.
2. *After the event* — a second pass sets `attended = Yes|No` from check-in. `activity_date` is the
   EVENT date, not the registration date, and must be `onlyIfAbsent`-protected so the second pass
   cannot move it (the grant-date bug of 8/31 was exactly this shape).

**Field mapping.**

| Activity field | From |
|---|---|
| `activity_date` | event `scheduling.startDate` (set once) |
| `activity_name` | `<event title> — <registrant name>` |
| `event_id` / `event_name` | event `id` / `title` |
| `event_type` | derived from the title/category — ⬜ CONFIRM the rule with Zach |
| `registered` | `Yes` once a registration exists |
| `attended` | check-in state, second pass only |

**Company resolution** follows the house rule: registrant email → GHL contact → `contact.businessId`;
no company means `needs-review`, never an invented one. Registrants who are not yet GHL contacts are
created by the existing `wix_ghl_sync_registrations` tooling, so that must run first — or the adapter
skips them as `no-contact` rather than guessing.

**Scope.** Only `TICKETING` and `RSVP` events have registrations in Wix. Many LRL events are
`EXTERNAL` (Manu-Tech Pitch Event, Startup Storytelling Series, Jackson County Manufacturing Trade
Show, the AEO workshops) — registration happens off-Wix, so Wix holds no attendee list. Those need a
manual path or they stay uncounted, and they are precisely the tech/innovation events TC asks about.

## Blockers, in order

1. **Wix API key needs Events read permission** including attendee contact details. Zach's action.
2. **Attendance is not currently being captured.** Every ENDED event checked reports `0 attended` — the
   check-in app exists but is not being used at the door. The adapter will faithfully report zero
   attendees against TC's target of 100 until that habit changes. Worth deciding before building the
   second phase.
3. **`event_type` derivation rule** — how to tell a Workshop from a Tech/Innovation Event, given the
   funder counts them under different KPIs.
