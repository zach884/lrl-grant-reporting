# Sprint spec — Find-or-Create (Upsert) Sync + Dedup

**Status:** draft for review
**Author:** drafted with Claude, 2026-07-17
**Owners:** Zach (product) · engineering

## 1. Goal

Make every sync able to **find an existing target and update it, or create one when none exists** —
in real time, gated by the right conditions, without ever producing duplicates. One engine concept
across both app pairs we sync today (GHL ⇄ Wix). Replace the reliability-fragile weekly CoWork tasks
with event-driven syncs.

### In scope (this sprint)
- **P1 — GHL Contacts → Wix Team CMS**, find-or-create, gated to *approved* contacts.
- **P2 — GHL Resources (custom object) → Wix Resources CMS**, find-or-create.
- A **per-connection config** to choose the match strategy, create policy, and gate at setup time.
- A **bidirectional ID-storage** convention so updates are always precise.
- A **dedup strategy** with a human-review escape hatch and a periodic audit.

### Explicitly out of scope (designed-for, not built now)
- **Wix → GHL reverse sync** (e.g. Wix Events registrations → find-or-create a GHL contact by email).
  Today a weekly CoWork task does this; it should eventually move into this app. The framework below
  is built so this is a new *config row with source=Wix*, not new plumbing. See §10.
- **De-provisioning** (removing/hiding a Team row when someone is un-approved). See §9 open item.
- **GHL → GHL create-and-associate** (create a company from contact data + link it). High-value but
  highest dedup risk; scoped as **P3 / next sprint** (§8.2), gated on P1/P2 proving the dedup model.

## 2. What already exists (so we build the delta, not the whole thing)

- **GHL→Wix already upserts.** `lib/wix-sync/sync.ts` queries the target collection by a match key
  (`matchSourceField` ↔ `matchTargetColumn`, e.g. contact `id` ↔ Wix `ghlContactId`), **patches** if
  found and **inserts** if not, stamping the match key on insert. Find-or-create is real today — it
  just runs off a weekly task, always creates (no policy toggle), has no gate, and only reads contacts.
- **The GHL↔GHL generic engine** (`lib/sync/{apply,dryrun,orchestrate}.ts`) already does object-agnostic
  read/coerce/equality/write with a hard-key/scalar traversal. Create-and-associate is the missing piece.
- **A real-time contact-change webhook** (`/api/sync/up.ts`) already fires reliably and drives the
  GHL↔GHL sync. P1's trigger is "also evaluate Wix sets on this same event," not a new trigger system.

**So the sprint delta is:** ID convention · config (policy + gate + secondary keys) · dedup algorithm ·
generalize the Wix source read beyond contacts · wire real-time triggers + gating.

## 3. ID storage strategy (the backbone)

Reliable updates require every synced pair to carry each other's stable id. We stamp **both** sides:

| Direction | Stored on the Wix row | Stored on the GHL record |
|---|---|---|
| Contacts → Team | `ghlContactId` = GHL contact id (**match key**, exists today) | `wixTeamRowId` = Wix item `_id` (**new** contact field) |
| Resources → Resources | `ghlResourceId` = GHL resource record id (**match key**) | `wixResourceRowId` = Wix item `_id` (**new** field) |

- The **Wix-side id is the authoritative match key** — find is always "query Wix where `ghl<Obj>Id` =
  source id." Idempotent by construction: one source → one target row, forever.
- The **GHL-side id is written back** on create/first-link. It's not required to *find* the row, but it:
  (a) proves a row exists (fast dedup guard, no query), (b) is the audit trail, (c) is the hook the
  future Wix→GHL direction and any reverse lookups will use.
- Convention: match-key column named `ghl<SourceObject>Id`; GHL write-back field `wix<Collection>RowId`.
  Both are created automatically if missing (`createField` already exists for the Wix side).

## 4. Config model (define it at setup)

Concrete additions to the existing tables (Drizzle, `lib/db/schema.ts`). Backward-compatible defaults
keep current behavior.

### 4.1 Wix sets — `wix_mapping_sets` (+ `WixMappingSet` in `lib/mapping/wixTypes.ts`)
```
create_policy    text  not null default 'find_or_create'  -- 'update_only' | 'find_or_create'
gate             jsonb                                     -- status→action map (§4.3); null = always upsert
secondary_match  jsonb                                     -- [{ sourceField, targetColumn }] for first-link dedup
writeback_field  text                                      -- GHL field to store the Wix row _id (e.g. 'contact.wix_team_row_id')
visibility_column jsonb                                    -- { column, visibleValue, hiddenValue } — engine-set (§6.1)
```

### 4.2 GHL↔GHL syncs — `syncs`
```
create_policy   text  not null default 'update_only'
                -- 'update_only' | 'find_or_create' | 'find_or_create_with_association'
gate            jsonb
secondary_match jsonb   -- e.g. company dedup by website/domain then name
```

### 4.3 Gate = a status→action map (evaluated on the source record)
The gate maps a status field's value to an engine action, plus an optional write-back after a
successful publish:
```jsonc
{
  "field": "contact.status",
  "actions": {                    // value -> action
    "Approved":  "upsert",        // find-or-create + sync fields
    "Published": "update",        // update existing only (don't create)
    "Hidden":    "hide",          // de-provision the Wix row (§6.1), keep ids
    "Pending":   "skip",
    "":          "skip"           // blank = rejected
  },
  "onPublishSetStatus": "Published" // after a successful create/publish, write status back
}
```
Actions: `upsert` | `update` | `hide` | `skip`. Unlisted values default to `skip`.

### 4.4 Team status lifecycle (`contact.status`) — decided 2026-07-17
Values: **Pending · Approved · Published · Hidden** (+ blank = rejected).

| `contact.status` | Meaning | Engine action on a contact change |
|---|---|---|
| *(blank)* | rejected / not wanted | none — never create; if a linked row exists → hide |
| Pending | form submitted, awaiting review | none — don't create yet |
| Approved | team approved; push to Wix | **find-or-create** + sync → on success **set status = Published** |
| Published | live on the site | keep the row **updated** on edits; ensure visible |
| Hidden | pulled from the site | **hide** the Wix row (don't delete); keep link + ids |

Notes:
- **Approved is the first-publish trigger; Published keeps the row in sync** (real-time updates without
  re-approving each edit) — *pending Zach's confirmation of the auto-update-while-Published behavior.*
- The engine **writes `contact.status`** on the Approved→Published transition (only on successful
  publish; loop-safe — Published re-fires converge to a no-op and don't rewrite the status).
- `Hidden`/`blank`-with-existing-row → hide via §6.1 (mechanism TBD §9.3). Re-approval un-hides.

## 5. Match & dedup algorithm (the crux)

For one source record against one target connection:

1. **Hard-key find.** Query target where `ghl<Obj>Id` = source id.
   - Found (exactly 1) → **UPDATE** (equality-guarded, same as today). Done.
2. **Hard-key miss → secondary match** (only if `create_policy` allows create):
   - For each configured `secondary_match` key in order, query the target.
   - Exactly 1 hit → **ADOPT**: treat as the target, **stamp the hard key** (and write back), then UPDATE.
     This is how we absorb pre-existing hand-created rows without duplicating them.
   - **>1 hit → STOP.** Do not create, do not guess. Emit a `needs-review` record (see §5.1).
   - 0 hits across all secondary keys → step 3.
3. **Create** (if `create_policy` = `find_or_create[_with_association]`):
   - Re-run the hard-key query **immediately before insert** (race guard for real-time double-fires).
   - Insert; stamp `ghl<Obj>Id` + write back `wix<Obj>RowId` to GHL in the same unit of work.
4. **`update_only`** and no hard-key hit → skip (with a `note`), never create.

### 5.1 Dedup safety rails
- **Idempotent hard key** makes steady-state impossible to duplicate.
- **Secondary match is conservative:** strong keys first (email / website-domain), fuzzy last (name);
  ambiguity always defers to a human rather than creating.
- **`needs-review` queue:** ambiguous/failed matches are recorded (table or report) surfaced in the hub,
  never silently resolved.
- **Race guard:** re-query before insert + immediate hard-key write-back closes the double-fire window.
  At our scale (~1k contacts, low write rate) this + a nightly **dedup audit** (group by secondary key,
  flag >1 unlinked) is sufficient; no distributed locking needed.

### 5.2 Per-object dedup keys (to confirm — §11)
| Object | Hard key | Secondary (first-link) | Ambiguity |
|---|---|---|---|
| Wix Team | `ghlContactId` | **email** (decided — link by email first, then the id becomes the durable link) | defer to review |
| Wix Resources | `ghlResourceId` | **natural key TBD** — resources have no email; need a stable field (title? slug? code?) — §9.4 | defer to review |
| GHL Company (P3) | none initially | website/email-domain → name | never auto-create; review |

**Rollout linking (decided):** existing Team rows are matched by **email first** to adopt them and stamp
`ghlContactId`; from then on the id is the primary match. Same idea for Resources once its natural key is set.

## 6. Create semantics per surface

- **GHL → Wix (P1/P2):** `insertItem` with the mapped fields + the stamped `ghl<Obj>Id`; then write
  the returned `_id` back to the GHL record's `writeback_field`. (Insert path exists; add write-back +
  policy + gate + secondary match.)
- **GHL → GHL create-and-associate (P3):** create the target object record (`POST /objects/{key}/records`),
  set the scalar FK that encodes the association (e.g. `contact.businessId = newCompanyId`), then run the
  normal field push. Seed fields from the existing connection's mapping rows. See §8.3.

### 6.1a VERIFIED against the live Team collection (2026-07-20 probe)
Publish state is `data._publishStatus` = `PUBLISHED` | `DRAFT` (a system field), plus `_publishDate` /
`_draftDate`. Confirmed by a self-cleaning probe:
- **A REST insert lands `DRAFT`** → a new approved member is hidden until we publish it.
- **`_publishStatus` IS patchable both ways** via bulk patch with `publishPluginOptions.includeDraftItems:
  true` (DRAFT→PUBLISHED to show, PUBLISHED→DRAFT to hide). No Velo needed.
- **Every draft-row op needs `includeDraftItems: true`** — query (done in #3), **patch** (must add), and
  delete (`?publishPluginOptions.includeDraftItems=true`).
Engine flow (publishState visibility): write fields (with includeDraftItems) → then **ensure
`_publishStatus=PUBLISHED`** for a live member (publishes a fresh insert / republishes a hidden one), or
patch it to `DRAFT` to hide. Only patch `_publishStatus` when it actually needs to change (idempotent).

### 6.1 De-provision / hide — CORRECTED: Wix native Publish/Draft state (not a column)
The Team collection's "Status: Published/Draft" seen in the CMS is **Wix's built-in publish state**
(the collection's Publish plugin), NOT a data column — which is why it never appears in the collection's
field schema and has no key to pull. It's controlled by dedicated Data Items operations:
- **hide** → **Unpublish** the item (`POST /data/v2/.../unpublish`, `UnpublishDataItem`).
- **show / make live** → **Publish** the draft (`PublishDataItemDraft`). A freshly **inserted** item is a
  **Draft**, so a new approved member = insert → publish.

**⚠️ Dedup-critical:** normal item queries return **published items only**. Every find/match lookup must
pass **`publishPluginOptions.includeDraftItems: true`** (and patches likewise), or a *drafted* person is
invisible to the sync → we create a **duplicate**. So the match query in §5 gets draft inclusion.

**⚠️ Two different "status" concepts — don't conflate:**
- **GHL `contact.status`** — the gate/lifecycle (Pending/Approved/Published/Hidden). Drives engine action.
- **Wix publish state** — visibility only (Published/Draft). Engine-controlled via publish/unpublish.

Engine bridge:
| Engine action (from GHL `contact.status`) | Wix item publish state |
|---|---|
| upsert / update (Approved, Published) | **Published** (publish the draft / ensure published) |
| hide (Hidden, or blank/Pending with an existing linked row) | **Draft** (unpublish) |

**Visibility config is a discriminated union** so it stays generic per "any CMS table, same setup":
`{ mode: 'publishState' }` (Team, and any Publish-plugin collection) OR `{ mode: 'column', column,
visibleValue, hiddenValue }` (a collection that instead filters on a real column). Re-approval republishes;
the row + ids persist (no re-dedup).

## 7. Generalize the Wix source read (needed for P2 Resources)

`lib/wix-sync/sync.ts` is hardwired to contacts (`getContact`, `resolveContactField`). Resources is a
GHL **custom object**, so generalize the source read to the object-agnostic `readRecordFields`
(already used by the GHL↔GHL engine) keyed on `set.sourceObject`. This is the same move that made the
GHL↔GHL engine object-agnostic; low risk, mostly a read-path swap.

## 8. Triggers (real-time, replacing weekly CoWork tasks)

### 8.1 Contacts → Team (P1)
- Hook into the existing **contact-change webhook**: after the GHL↔GHL step, evaluate every enabled
  Wix set with `sourceObject = 'contact'`; for each, check the **gate**, then run the upsert.
- Result: the moment a contact's "Become an Expert" status flips to Approved (or an approved expert's
  mapped fields change), Team updates/creates in real time.

### 8.2 Resources → Wix Resources (P2)
- **Real-time confirmed:** GHL can fire a webhook on **Resource Created / Resource Changed** (true for
  all custom objects). So a GHL workflow → webhook (`/api/sync/object-change?object=custom_objects.resources`)
  drives this in real time — no reliance on a sweep as the primary path.
- Keep a scheduled **sweep** only as an optional backstop for missed fires (reuse the reconcile harness:
  `runPool` + checkpoint + report). (Note: since custom-object triggers exist, the "no company-updated
  trigger" limitation does NOT apply here — and is worth revisiting for P3 too.)

### 8.3 GHL → GHL create-and-associate (P3, next sprint)
Trigger = contact change where company-data fields are set **but `businessId` is null**. Then: dedup-find
a company (website/domain → name); adopt+associate if found, else create+associate. Highest dedup risk —
do it after P1/P2 validate the secondary-match + review-queue model on the lower-risk one-way Wix path.

## 9. Decisions (2026-07-17) + remaining specifics
1. **Existing Team rows — DECIDED:** first-link by **email**, adopt the row, stamp `ghlContactId`; the
   id is the durable match thereafter. (No assumption that existing rows already carry the id.)
2. **Gate — DECIDED:** field = `contact.status`, values **Pending / Approved / Published / Hidden**
   (+ blank = rejected). Full state machine in §4.4. *Two confirmations pending:* (a) Published profiles
   auto-update on field edits (assumed yes — real-time); (b) OK for the engine to write `contact.status`
   back (Approved→Published on successful publish).
3. **Un-approval — DECIDED: HIDE via the Wix `Status` column** (`Visible`/`Hidden`), which the Team pages
   already filter on (§6.1). Engine sets `Status=Hidden` to hide, `Visible` to show. No delete, no draft/publish.
4. **Resources — DECIDED: same framework as Team** (gate + hard-key `ghlResourceId` + secondary first-link
   + hide-on-ungate). *Two resource specifics needed:* (a) a natural dedup key (resources have no email —
   title? slug? code?), and (b) whether Resources has its own status gate or all resources sync.
5. **Resources real-time — DECIDED: yes.** GHL fires webhooks on Resource Created / Changed (all custom
   objects), so it's event-driven like contacts; sweep is only a backstop.

## 10. Future-proofing for Wix → GHL (Events registrations)
Not built now, but the model absorbs it as a **source=Wix connection**: match a Wix registration to a
GHL contact by `ghlContactId` (hard) → email (secondary) → create contact if none; stamp ids both ways.
Same config (policy/gate/secondary/dedup), reversed direction. The bidirectional ID convention in §3 is
exactly what makes this a config addition rather than a rebuild.

## 11. Phasing & rough sequence
- **Phase 1 — Contacts → Team, real-time, gated, find-or-create.** ID write-back, `create_policy`,
  `gate`, secondary-match + review queue, wire into the contact webhook. *Ship + watch on approved test
  contacts (dry-run → live), retire Aiden's weekly Team task.*
- **Phase 2 — Resources → Wix Resources.** Generalize the Wix source read to custom objects; add the
  Resources set; trigger (workflow webhook and/or scheduled sweep). *Retire the weekly Resources task.*
- **Phase 3 (next sprint) — GHL→GHL create-and-associate**, once dedup is proven.
- **Future — Wix→GHL Events**, per §10.

## 12. Verification approach (same rigor as the engine cutover)
- Dry-run every set against real records before any live apply (the Wix engine already has a dry-run path).
- Dedup audit report run before go-live: for each object, group by secondary key, flag any >1 unlinked
  cluster for manual resolution.
- Roll out on a small set of *approved test contacts* first; confirm find (update), first-link (adopt),
  and create paths each behave, and that re-runs are no-ops (idempotent).

## 13. Related context & future roadmap (not this sprint)
- **Placement columns** `program` / `collective` on the Team collection decide *where* a member/EIR shows
  up. These are normal **mapped fields** (GHL → Wix, MULTI_REFERENCE per the existing Team set), already
  in scope of the field mapping — no special handling beyond the reference resolution the engine has.
- **Per-page sort order** — the Team collection has `# rank` fields for manual ordering across pages,
  which is painful to manage in the Wix CMS. **Roadmap idea (Zach, 2026-07-17):** a drag-and-drop
  interface in *this* app to set per-page sort orders on Wix CMS tables. Out of scope here; noted so it
  isn't lost.
