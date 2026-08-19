# Sprint B — Activity tracking ("log the interaction once")

> Status: **IN BUILD** (spec 2026-08-19; **rescoped mid-session by Zach** from a staff-entry form to
> source-driven ingestion — see "The sources"). Roadmap slot: Phase 2 / Sprint 3.
> Predecessor: Sprint A closed 2026-08-19. Successor: **Sprint C — the report engine**.
> Acceptance: every activity that happens gets a record, once, attached to its company, with no
> duplicates on retry — and the reports can be built on it.

## Why this sprint

The North Star is "log each client interaction **once**, and every funder report computes itself."
`custom_objects.activities` has been live since 2026-07-08 with 101 fields, and it holds **two
records** — both April test rows. Nothing writes to it. That is the gap.

**The key reframe (Zach, 2026-08-19):** almost nothing here is typed by a staff member. Each activity
type already has a real-world source — a form, a calendar booking, a Wix sync, a pipeline stage. So
Sprint B is an **ingestion layer**: one shared, idempotent create path plus a small adapter per
source. A manual form is the *exception* path, not the product.

## The sources

| Activity type | Source | Trigger | Notes |
|---|---|---|---|
| **Metrics** | **Client Reporting Form** (GHL) — id `ed03BbRGWrc6Ugtwr9JB` | form submission | one snapshot per client per period |
| **Grant** | **Direct Grant Application form** (GHL) — id `0d8irJ6Ay6VQFajG06Go` | form submission | detail fields; the pipeline supplies `grant_status` |
| **Introduction / Referral** | **This app's form** (`/`) | staff logs it | internal, so it can look the counterparty up dynamically — see below |
| **Intake** | GHL calendar / appointment link | appointment webhook | routed by which calendar was booked |
| **Technical Assistance** | GHL calendar / appointment link | appointment webhook | routed by which calendar was booked |
| **Workshop / Event** | Wix attendance | scheduled sync (existing `wix-ghl` tooling) | registered vs attended |
| **Program acceptance** ⭐ NEW | GHL opportunity moved to a pipeline stage | workflow webhook | needs a new `activity_type` option |

⭐ **Program acceptance is a 7th type and does not exist yet.** The live `activity_type` field has
exactly six option keys, so this needs an option added via the idempotent setup script (a live schema
change), plus a stage→program config. `CUSTOM_OBJECTS_SPEC.md` anticipated this slot
("room to grow, e.g. `cohort_enrollment`").

## Live ground truth (measured 2026-08-19, not assumed)

`custom_objects.activities` — 101 fields in 6 folders: Activity Info 8 · Technical Assistance 2 ·
Referral 2 · Event 5 · Grant 49 · Metrics 35. `activity_type` keys: `intake`,
`technical_assistance`, `introduction_referral`, `workshop_event`, `grant`, `metrics`.

Associations that exist live (resolve by **key**, never by hardcoded id — v1 hardcoded them):

| id | key | shape |
|---|---|---|
| `69fba8044778fa17f925406e` | `company_activity` | business ↔ activity |
| `69cfd43a7dde13295d11fe26` | `activity_contact` | contact ↔ activity |
| `69cfe156dd8fc9d773987042` | `referral_received_referred_to` | contact (Referred To) ↔ activity |
| `69fba7b23787921fb34dc58b` | `primary_company_opportunity` | business ↔ opportunity (the program-acceptance path) |

**Two API facts probed live this session, both load-bearing for this design:**

1. **Records search filters on a property server-side:**
   `POST /objects/{key}/records/search` with
   `filters: [{ field: 'properties.<bareKey>', operator: 'eq', value }]` → works.
   (`field: '<bareKey>'` → 422 "Invalid field"; `searchFilters` → 422.) Free-text `query` matches the
   record NAME only, not property values, so it cannot be used as a lookup.
   Necessary, but NOT sufficient on its own — see the next finding.
2. **The search index LAGS a new record by ~12 seconds.** Created a record, then polled the search
   filter above every 2.5s: first hit at **12.0s**, while a direct `GET /records/{id}` worked
   immediately. So the index — not the write — is what lags. **This is why idempotency cannot rest
   on a GHL search:** webhook retries arrive in seconds, the search says "not found", and a
   duplicate is born. Proven, not theorised: a three-delivery live test produced **three records**.
3. **`/associations/relations/{id}` pages with `limit` + `skip`** (`page`/`offset` 422) and returns an
   accurate `total`; mixed link types come back together. Paging matters because the nightly scorer
   appends a Client Stage record per company forever, and an unpaged 100-row read would eventually
   push a company's activity links off the end.

## THE prerequisite — idempotency

Every source in the table fires more than once for the same real-world event: GHL retries webhooks,
`fastAck.ts` says outright *"do not adopt this pattern for a non-idempotent handler"*, forms get
resubmitted, and nightly syncs re-run. Without a natural key per source, each retry creates another
activity — and duplicate activities **double-count in funder reports**, which is the worst failure
mode this system has, because the numbers still look plausible.

So the first thing built is **find-or-create on a source key**, resolved in three steps — cheapest
and most reliable first, because the obvious single step does not work:

1. **The claims ledger** (`activity_source_claims` in Postgres) — `UNIQUE (source, source_record_id)`.
   Postgres is immediately consistent, which is exactly what the GHL index is not. Insert-or-nothing
   *is* the mutual exclusion: one caller wins the claim and creates the record, the others read the
   winner's id. A create that throws releases its claim so a retry isn't blocked by a dead one.
2. **The GHL search** (`properties.source_record_id eq <id>`) — the fallback, and it self-heals: a
   hit is written back into the ledger so the next delivery skips the lagging index entirely. It
   also covers events claimed before the ledger existed, or created by a backfill elsewhere.
3. **Create**, then publish the record id to the claim.

Supporting pieces:

- Two new core fields on the object, live since 2026-08-19 (`scripts-ts/activity-source-fields.ts`,
  idempotent): `activity_source` (which adapter wrote it) and `source_record_id` (that source's own
  id). Both are `[SYNC]`-prefixed and excluded from the manual form — `source_record_id` IS the
  idempotency key, so a typo in it would let the next delivery duplicate.
- ⚠️ **The source filter must use the option KEY, not the label.** `activity_source` is
  SINGLE_OPTIONS: the write sends `"Manual"` and GHL stores `"manual"`, so filtering on the label
  matches nothing — verified live (label → 0 hits, key → 1). This fails *silently*: no error, just a
  lookup that never finds anything and duplicates forever.
- On update, the desired state is **diffed here** before calling `writeRecordFields` — that writer
  sends every scalar it is handed (only modifier fields diff internally), so passing the full state
  would rewrite an unchanged record on every re-delivery. In the sync engine the dry-run planner owns
  that comparison; for ingestion, `upsertActivity` is the planner.
- `appointment_id` (already on the object) is the appointment adapter's source id; `event_id` groups
  attendee rows into one event.

**Verified live 2026-08-19:** 7 deliveries of one source event — repeat, changed, repeat, and a
concurrent burst of 3 — produced **1 record**: `created → noop → updated → noop`, no duplicates.

## Shared core (built 2026-08-19, phase 1 — done)

Every adapter goes through one path, so they cannot drift:

- `lib/activities/schema.ts` — the type registry. Field sets are read from the LIVE catalog **by
  folder**, so a field added in GHL appears everywhere with no code change. Only policy (required /
  prominent fields, which types are staff-loggable) is hand-authored.
- `lib/ghl/createRecord.ts` — `createObjectRecord`, the create counterpart to `applyObjectWrite`:
  create-mode coercion (multi-selects are a plain array of option keys at create; the `{add,remove}`
  modifier is an *update* rule), then **read the record back** and report per field. GHL accepts
  writes it does not store, and at create that is worse than on update — the record exists, so
  nothing looks wrong, but the field is empty forever.
- `lib/activities/create.ts` — `createActivity`: validate → create → associate (company always,
  contacts, referred-to) → one `change_log` row with `actorKind: 'staff'`. A failed company link is
  **reported, never swallowed**: an activity with no company is invisible to reporting, which is
  worse than an error because someone believes it was logged.
- `lib/activities/list.ts` — company timeline via the association graph (not by parsing
  `activity_name`, which is what v1 did).
- `lib/ghl/associations.ts` — `resolveAssociationId(key)` (cached), `getAllRelations` (paged),
  `getRelatedRecordIds`.
- 31 unit tests covering the registry, validation, associations, audit and the "accepted but not
  stored" case.

## What v1 got wrong (being replaced)

`pages/index.tsx` + `pages/api/activities/*` as of `d950d99`: contact-centric with **no company
association at all**; hardcoded association ids; multi-selects written as plain arrays **on update**
(422 at best, a wiped field at worst); no read-back; no change-log row; only 3 of the type-specific
fields reachable; `activity_owner` hand-typed. Measured evidence: the surviving v1 test activity has
**zero** relations — its association step was failing in practice, not just in theory.

## Phases

| # | Phase | State |
|---|---|---|
| 1 | **Shared core** — registry, verified create, associations, audit, timeline, tests | ✅ done |
| 2 | **Idempotency** — source-key fields, claims ledger, `upsertActivity`, noop on re-delivery | ✅ done, verified live |
| 7 | **Referral logger + back-up form** — rebuilt at `/`, company-first, cross-entity referral picker | ✅ done, verified live |
| 3 | **Appointments → Intake / TA** — webhook, calendar→type config, status handling | ✅ done, verified live (`f3d1d6d`) |
| 4 | **Program acceptance + grant lifecycle** — 7th `activity_type`, stage→program config | ✅ done, verified live (`388de12`) |
| 5 | **Forms → Grant + Metrics** — Direct Grant Application + Client Reporting Form → activity, via a contact-field→activity-field map | **next** |
| 6 | **Wix attendance → Workshop/Event** — registered vs attended, one record per attendee | |
| 8 | **Backfill + live verification** — history per source, dry-run → review → apply | |
| — | Zoom AI Companion notes onto appointment activities | Sprint 5 (feasibility spike open) |

## Open questions / risks

- **Forms write to CONTACT fields, not to the object.** That is why the Grant/Metrics field keys read
  like contact keys. Consequence: the *second* metrics survey overwrites the first on the contact, so
  **prior-period snapshots are already being lost** — the Activity record is what makes each
  submission a period snapshot. Ingestion needs a contact-field → activity-field map (84 fields);
  the mapping engine already does exactly this shape of work and should be reused, not re-invented.
- **`reporting_period` must be derived at ingestion** (submission date → H1/H2 window), or two
  snapshots collide and neither is attributable to a reporting period.
- **Company derivation** for every source: `contact.businessId` first, name match second,
  `needs-review` third — never invent a company (the `resourceRelations.ts` rule). A brand-new
  contact with no `businessId` is the realistic failure mode.
- ~~Booked ≠ held~~ / ~~calendar routing as config~~ — both settled in phase 3 above.
- **Zoom AI Companion is now more than a nice-to-have:** it is the most reliable "did this meeting
  happen" signal available, because the team doesn't maintain appointment status. Needs a Zoom
  Server-to-Server OAuth app (none configured yet); `past_meetings/{id}` + `/participants` answer
  attendance, `meetings/{id}/meeting_summary` returns the AI Companion notes.
- **Attribution:** automatic sources set `activity_owner` from the appointment's assigned user, not
  from whoever is logged into the app.
- **Backfill:** history matters for reporting — past appointments, past events, and the grant/metrics
  answers already sitting on contacts. Each adapter needs a batch mode under dry-run → review → apply.
- **The gap no source covers:** phone calls, emails, and hallway advice have no automatic trigger. If
  ingestion is the only path, TA effort is undercounted in TC/SBSH. Hence phase 7.
- FILE_UPLOAD at create is unverified (`coerce.ts` skips it deliberately); only Grant uses file
  fields, and they can be attached on a follow-up update.
