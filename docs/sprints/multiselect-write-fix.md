# Sprint spec — GHL object MULTI-SELECT writes (correction) + 5 Wix-sync defects

**Status:** SCOPED, evidence attached. **Verified live:** 2026-08-17 (LRL live location `FgnVVv4smxyBNJKFZgJv`).
**Why now:** our `CREATE_ONLY_TYPES = {MULTIPLE_OPTIONS}` rule is **wrong**, and it has been silently
destroying data on the resources object since 2026-07-30.

---

## 1. The correction: object multi-selects ARE updatable

`lib/ghl/coerce.ts` treats `MULTIPLE_OPTIONS` as create-only for `business` + `custom_objects.*`, based on
2026-07-07 testing where every value shape returned `422 "unexpected format"`. That conclusion was an
artifact of only ever sending **values**. The update API expects a **modifier object**:

```http
PUT /objects/{objectKey}/records/{recordId}?locationId=<LOC>
Content-Type: application/json

{ "properties": { "<bareKey>": { "add": ["<optionKey>"], "remove": ["<optionKey>"] } } }
```

Evidence (both objects, live):

| Payload | Result |
|---|---|
| `{collectives: {add:['mainstreet']}}` | **200**, `['lean_startup','mainstreet']` — appends |
| `{collectives: {add:['manufacturing','mainstreet']}}` | **200**, dupe-safe (idempotent) |
| `{collectives: {remove:['mainstreet']}}` | **200**, removes |
| `{collectives: {add:[...], remove:[...]}}` | **200**, both applied in one call |
| `{i_am_selling: {add:['service']}}` on **business** | **200** — same semantics on the company object |
| `{collectives: {add:['Lean Startup']}}` (LABEL not key) | 200 but **silent no-op** — keys only |
| `{collectives: {set:[...]}}` / `{replace:[...]}` | 422 — **no set/replace modifier exists** |
| `{collectives: ['lean_startup']}` (plain array) | 422 `"unexpected format"` |
| `{collectives: 'lean_startup;mainstreet'}` (plain string) | **200 — and WIPES the field to null** ⚠️ |

Two consequences beyond the API contract:

- **The plain-string case is a silent destructive write.** Our resource tagger has been sending
  `'; '`-joined strings since 7/30, so every run was *clearing* stop values while reporting `applied`.
- **The workflow-enroll workaround** (`Update Company Multi-Select`, wf `50eac67a-…`) is no longer
  required for company multi-selects. Keep it available, stop depending on it.

### Work items

1. **`lib/ghl/coerce.ts`** — drop `MULTIPLE_OPTIONS` from `CREATE_ONLY_TYPES`. For object writes, emit a
   modifier intent rather than a scalar: coerce the desired labels/keys → **option keys**.
2. **`lib/ghl/writeRecord.ts`** — `writeObjectRecord` must diff to be authoritative: read the record's
   current array for that field, then send `{add: desired − current, remove: current − desired}`; skip the
   property entirely when the diff is empty (keeps the sync equality-guarded/idempotent).
   Guard: **never** fall through to a plain string/array for a MULTIPLE_OPTIONS property.
3. **Report honestly** — `applied` currently includes fields GHL dropped. Anything skipped or unwritable
   must land in `skipped` with a reason so `change_log` stops recording false positives. A cheap
   post-write read-back assert on option fields would have caught this in July.
4. **Re-probe `CHECKBOX` / `TEXTBOX_LIST`** on objects with the modifier shape before we keep trusting
   "UI only" — the same measurement error may be hiding there.
   **DONE 2026-08-17 — and CHECKBOX was mis-measured too.** Probed live on a scratch company with
   every shape (`scripts-ts/probe-checkbox-writability.ts`, creates + deletes its own record):

   | Payload for a `CHECKBOX` property | Result |
   |---|---|
   | `{add:['key']}` | **200, persists** |
   | `{add:['k1','k2']}` | **200, persists both** |
   | `{remove:['key']}` | **200**, removes |
   | `{add:['LABEL']}` | **200, persists** — GHL resolves the label here (unlike MULTIPLE_OPTIONS, where a label is a silent no-op). Still send keys. |
   | `['key']` / `['LABEL']` (plain array) | 422 `"We couldn't apply updates to <field>"` |
   | `'key'` / `'LABEL'` / `'k1;k2'` (plain string) | **200 — stores null** ⚠️ |
   | `true` (boolean) | **200 — stores null** ⚠️ |

   So `CHECKBOX` is now out of `UNWRITABLE_TYPES` and in `MODIFIER_TYPES`, sharing the
   MULTIPLE_OPTIONS code path. This unlocks two real company fields that were considered dead:
   `my_company_is_interested_in_the_following_programs_company` and
   `my_company_is_most_interested_in_the_following_resources_company`.

   `TEXTBOX_LIST` remains refused but is **unprobed** — no field of that type exists on the location
   to probe against, so treat it as unverified rather than proven.
5. **Then migrate the resource stop fields back to MULTIPLE_OPTIONS.** I recreated
   `mrl_stops`/`trl_stops`/`crl_stops`/`investor_readiness_stops` as **TEXT** on 2026-08-17 so tagging
   would work *today* (new ids: `nZL8s4Dvek6AN07Axha0`, `7PIzz2CPoi7p2qP0cgWM`, `dIacjRck0d6d0A8WYCU0`,
   `tQVyqL0qZGHygVyPKTLA`). Once item 2 ships: delete+recreate as MULTIPLE_OPTIONS (`1`..`10`, key=label),
   then migrate the existing `';'`-joined values with `{add:[keys]}` per record. Note delete+recreate with
   the same `fieldKey` **preserves stored values**, but a type flip leaves them in the wrong shape, so do
   the rewrite pass in the same script. `service_areas` can follow the same path (29 option keys).
   Also drop the now-unneeded `[,;]`-split leniency once the source is a real array.

   **DONE 2026-08-17 for the 4 stop fields** (`service_areas` deliberately left as TEXT for now —
   29 option keys, and it can be flipped independently with `--include-service-areas`).
   Script: `scripts-ts/resources-fields-to-multiselect.ts`. New ids after the flip:
   `4kLze2BRcwGkWgyCgRBv` (MRL, keys 1–10), `L7EeA25FiBzcYEswPSrJ` (TRL), `Y7zrcmyHaibBB72azDV5`
   (CRL), `kTcUSeWHo9SbJcFcyEgJ` (IRL) — TRL/CRL/IRL keys 1–9, matching the line lengths in
   `lib/enrichment/data/readiness.ts`.

   ⚠️ **CORRECTION to the plan above — a same-script rewrite is NOT sufficient.** The preserved TEXT
   value doesn't merely sit in "the wrong shape"; it makes the field **unwritable** until cleared:

   | Attempt on a freshly-flipped field still holding `"1;3"` | Result |
   |---|---|
   | `{add:['1','3']}` | **500** `"Something went wrong"` (and the client burns 6 retries on it) |
   | `{remove:['1;3']}` | **400** `"MRL Stops includes values that don't match what's saved."` |
   | plain string `''` (deliberate wipe) → then `{add:['1','3']}` | **200** → stores `["1","3"]` ✅ |

   So the migration is **wipe → add**, per field, per record. The wipe primitive is the same footgun
   documented in §1 (a plain string on a modifier field stores null) — used here on purpose. A first
   attempt without the wipe step 500'd on every record and wrote nothing; no data was lost because
   the values were backed up to `reports/resources-readiness-values-backup.json` before the flip.
   **Always back up field values before a type flip, and never assume value preservation implies
   value usability.**

**Debugging rule to adopt:** always surface the **full** GHL error body. Both the July dead end and my
first pass today came from a truncated `422` message; the phrase "unexpected format" is the tell that a
*modifier* is expected, not a value.

### 1b. FILE_UPLOAD on objects uses the SAME modifier family (found 2026-08-17)

The value shapes that work for contacts do **not** work on object records. Verified live on
`custom_objects.resources.resource_logo`:

| Payload for `properties.resource_logo` | Result |
|---|---|
| `{add:[{url:"<ghl file url>"}]}` | **200, persists** — GHL fills in `meta.name/extension/size` itself; **dupe-safe** on re-add |
| `{remove:[{url}]}` | **200**, detaches |
| `{add:[{url, meta:{...}}]}` | 422 `"We couldn't process file updates for Resource Logo."` |
| `{add:["<url>"]}` (bare string in array) | 422 |
| `[{url, meta}]` / `["<url>"]` (plain value) | 422 |
| `"<url>"` (plain string) | 200 but stores **null** |

Upload step is unchanged: `POST /locations/{loc}/customFields/upload` (multipart: `file`, `id`=<fieldId>,
`maxFiles`) → the returned `msgsndr-private.storage.googleapis.com` url is **publicly fetchable** (so Wix
media import accepts it). The resulting stored value is **structurally identical** to what a GHL form
upload produces, and renders in the record UI (confirmed by Zach on Curated Grants).

**Backfill done 2026-08-17:** all **91** resource records now carry `resource_logo` — 89 re-hosted from the
old `logo_url` Wix URLs (normalized through the Wix `fit` transform to PNG, which also handles the 2 AVIF
sources), plus the pilot and the form-uploaded one. 0 failures. GHL is now the display + source of truth
for resource logos.

⚠️ **The `resource_logo → logo` mapping row is TEMPORARILY REMOVED** (was sort_order 16). With 91 logos now
populated and no image equality guard (§2.2), every sync run would re-import all 91 into the Wix Media
Manager. **Restore that one row as soon as the guard ships** — Wix already holds correct logos, so nothing
is lost meanwhile.

---

## 2. Five Wix-sync defects found in the same pass

### 2.1 Form-uploaded files never reach Wix (data loss, fix first)
`fileUrl()` in `lib/wix/coerce.ts` handles a url string and an array of `{url}`, but a file uploaded through
a **GHL form** stores as a **uuid-keyed map**:

```json
{ "ced71d35-1d7a-48fa-89ec-400fa054d091": { "meta": {...}, "url": "https://services.leadconnectorhq.com/documents/download/…" } }
```

→ coercion returns `skip: "no file url"`, so every new expert's headshot and company logo silently never
sync. Handle all three shapes (and note those `documents/download` URLs are publicly fetchable, so Wix's
media import accepts them). I hand-normalized the two current contacts as a stopgap.

### 2.2 Syncs never converge — image + reference churn (highest-value fix)

**Symptom.** In `lib/wix-sync/sync.ts`, only `result.kind === 'value'` is equality-guarded against the
existing row (`valuesEqual`, ~line 282). `kind === 'image'` (~286) and `kind === 'reference'` (~289) push
intents **unconditionally**, and the apply path then calls `importImageFromUrl` (~334-343) and
`replaceReferences` (~358-370) every single run. Because `action` is derived from `written.length`
(~325), a set that maps an image or a reference **can never report `noop`**.

**Measured impact** (change_log, applied Wix writes only, 2026-08-05 → 2026-08-17 — i.e. just the 13 days
since the log shipped; the sync has been live since 7/21, so the real totals are higher):

| Metric | Count |
|---|---|
| Applied Wix write events | 170 |
| **Image column writes** (`image_fld`, `companyLogo`, `logo`) — each one is a **new Media Manager upload** | **126** |
| **Reference replace calls** (`program`, `programs`, `collectives`) | **269** |
| Worst-offending records | 11 runs each (`GjJQGARB6t…`, `lxHdl68Z7E…`), 10, 8, 8, 7, 7, 6 … |

**Direct proof** from the 2026-08-17 E2E test — two identical back-to-back pipeline runs on one record:
run 2 reported `unchanged: 13` **and** `written: [logo, programs, collectives]`, and the row's logo URL
changed from `…950721c0db7744158eae60be695ab6b6…` to `…04df5f8bdb0d4150886e010451ee9ad5…`. Same source
file, second copy in Media Manager.

**Why it matters:** Media Manager fills with duplicates; every row's `_updatedDate` churns, so the
readiness-bar gate "syncs observable, drift ~0" can never be satisfied; the change log fills with
non-events that mask real ones; and each run burns Wix API calls. Also worth checking why the
2026-08-04 runtime convergence guard (`548fc6a`) doesn't catch this — it may only wrap the GHL write path.

**Fix design.**
- **References — exact and cheap, no schema change.** The existing row is already fetched. Read its
  current referenced ids (`includeReferencedItems` on the row query, or the references read endpoint),
  resolve the desired ids as today, compare as **sets**, and skip `replaceReferences` when equal. Keep
  reporting genuinely-unmatched labels in `skipped`.
- **Images — needs a provenance marker,** since Wix rewrites the URL on import so the stored value can
  never be compared to the GHL source. Options, best first:
  1. A companion hidden TEXT column per image column (e.g. `logoSrc`, `imageSrc`) holding the GHL source
     url; write it alongside the image and guard on equality. Exact, cheap, survives Wix re-hosting.
  2. Treat image rows as `policy: 'fill-empty'` + an explicit `--force-images` flag. One line, but a
     replaced headshot then never propagates without the flag.
  3. Hash the bytes — correct but pays a download per run. Not worth it.
- **Make `action` derive from *effective* changes** so `noop` becomes reachable, and only log real writes.
- **Extend `scripts-ts/sync-doctor.ts`** to flag any column written on two consecutive runs with no source
  change — a regression test for this whole class of bug.
- **Complementary (cheap): give the sweep a delta filter.** `scripts-ts/resources-sync-run.ts` loads ALL
  records and syncs every one — there is no `--updated-since` cutoff and no fingerprint gate anywhere in
  `lib/` or `scripts-ts/` sync paths. The record search already sorts by `updatedAt desc`, so an
  `--updated-since` flag is a few lines. NOTE this is a multiplier, not the root cause: the field-level
  guard above is what fixes the webhook path, where a record touched for ANY reason re-imports its image
  (that is why the same 5–6 contacts churn 7–11 times each despite the Team sync being change-driven).

**A third churn source, same root cause class:** `readinessRationale` was written **67** times in the same
window. The rationale is free-text LLM output, so it varies run to run even when the tags and stops are
identical — every re-tag rewrites it and propagates to Wix. Today's runs for two coaches applied *only*
`contact.readiness_rationale` with service areas unchanged. Fix: treat rationale as **derived from the
tags** — only rewrite it when the tag/stop set actually changes (or pin temperature 0 and a fixed phrasing
template).

### 2.3 Reference label mismatches (silent partial writes)
Engine output for a live contact:
`unmatched references: Sales and Marketing, i4.0 Accelerator` · `unmatched references: Manufacturing Tech`
· and separately `Local` (vs Wix `LOCAL`).
- `Local → LOCAL` is only casing → make `resolveReferenceIds` case-insensitive (already on the open list).
- The other three are genuinely different names → add an optional per-row **`valueMap`** to the mapping
  row model + UI (`{"i4.0 Accelerator":"Industry 4.0 Accelerator", …}`). This is wanted by the
  generalized GHL↔Wix mapping module anyway. The **resources** object's labels already match Wix exactly,
  so this is contact-side only.

### 2.4 No trigger for the Resources pipeline
`/api/resource-sync` exists but nothing calls it — the 2026-08-07 form submission sat unsynced for 11 days.
Add `.github/workflows/nightly-resources.yml` (drafted, delivered separately: tag → sync, 08:45 UTC) and
add GitHub secrets `WIX_API_TOKEN` + `WIX_SITE_ID`. Real-time trigger is a GHL workflow on the Resources
object → `POST /api/resource-sync` with `{"recordId":"{{record.id}}"}` (Zach to confirm GHL exposes a
custom-object trigger).

### 2.5 Derive the company↔resource association from the submitting contact

**Verified 2026-08-17 (E2E test):** the reworked "Become a Resource" form matches the existing contact by
email and creates the **contact↔resource** relation itself (`resource_contact` `6a7a0a401b4a19424298a73d`,
0.3s after the record). It does **not** create the **company↔resource** relation
(`resource_company` `6a7a0a1d62d53d4b44142023`) — the form has no notion of the business object.

Per Zach, the **company link matters more than the contact link** for resources, so the pipeline should
guarantee it. Deterministic rule, in order:

1. **`contact.businessId` on the matched contact** — already populated (the form's contact match preserves
   it; on the test record it pointed straight at `6a4d574f4ebee4d821b49f16`). This is the primary path and
   needs no name matching. Equivalent read: the contact's `BUSINESSES_CONTACTS_ASSOCIATION` relation.
2. **No `businessId`?** Fall back to the form's "Contact Company Name" → the existing company
   find-or-create / LARA-ID dedup path. Do NOT write company-object fields from the form directly (that
   creates a new company per submission — see [[ghl-company-object-api-facts]]).
3. **Still nothing?** Leave it unlinked and surface it for review. Don't invent a company.

**Confidence check (cheap, worth having):** compare the resource `website` domain against the company
`website` domain. Agreement → link silently (the test record: `agilegrowthshop.com` both sides).
Disagreement → still link (Zach: easy to fix by hand later) but flag it, because the realistic failure mode
is an EDC/partner staffer submitting a resource on behalf of a *different* organization.

**Idempotency:** read existing relations first (`POST …/records/search` or
`GET /associations/relations/{recordId}` — note `GET /objects/{key}/records/{id}` returns `relations: null`
even when relations exist) and create only when absent.

**Backfill opportunity, separate job:** of the 92 resource records, only **2** have any relations at all
(Fidelis, hand-linked 8/10; and the test record). The 90 originally imported resources have **no contact
and no company** relation — so if resources should be joinable to companies for reporting, that is a
name/domain matching pass against the ~888 companies, not part of this fix.

---

## 3. Config already changed live (no code needed, FYI)

- Resources mapping set `0feeb2c1-…`: 15 → 20 rows (`title`, `logo`, `programs`, `collectives`,
  `rankLocalMainstreet`). `featured` deliberately left unmapped: GHL stores `"FALSE"` as TEXT and the
  BOOLEAN coercion is case-sensitive (`'true'`), so a `"TRUE"` would sync as **false** — fix the coercion
  or make the GHL field a `true`/`false` option field first.
- Both enricher gates widened to `{Approved, Published}` — they were `{Approved}` only, while the sync
  flips Approved → Published, so every record got exactly one enrichment attempt ever.
- Full resource sweep re-run through the deployed app: 91/91 enriched + synced, 0 errors.
