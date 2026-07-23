# Sprint spec — Resources / TAP side (Resources on the Startup Readiness Map)

**Status:** SCOPED — ready to build. **Author:** drafted with Claude (2026-07-23).
**Goal:** put LRL's ~90 **Resources** (Technical Assistance Providers) on the subway map, exactly the
way the **Team** (coach) side already works — one GHL object over.

## Principle (locked with Zach)
Treat Resources **identically to Team**: records are **hosted + managed in GHL** (the
`custom_objects.resources` object), **enriched in GHL** (readiness tagger → service tags + subway
stops), **synced GHL → Wix** via a Field Mapping (create / update / visibility gating), and the map
reads Wix. GHL is the system of record; the transform stays in code; only when/where is config.

## Current state (verified 2026-07-23)
- **GHL** `custom_objects.resources` (id `6a590064ad413a5431fc728e`) EXISTS with 13 base fields:
  `resources` (name), `category`, `sub_category`, `short_description`, `full_description`, `website`,
  `email`, `logo_url`, `slug`, `programs`, `collectives`, `featured`, `rank_local__mainstreet`.
  MISSING: the readiness fields + a status/gate field + a Wix-row-id writeback. **90 records exist**
  (matches the 90 Wix rows) — so this is a LINK/reconcile job, NOT a bulk create. Reconcile dry-run
  (2026-07-23) matched **90/90 cleanly**: 30 by slug + 60 by exact normalized name; 0 ambiguous,
  0 orphans either side, 0 fuzzy needed. All 90 GHL records have a name; only 30 have a slug.
- **Wix** `Import1` ("Resources") = 90 rows: `title`, `companyResourceName`, `category`,
  `subCategory`, `description`, `shortDescription`, `website`, `email`, `slug`, `logo` (IMAGE),
  `programs`/`collectives` (MULTI_REF), `featured`, `rankLocalMainstreet`. MISSING: `serviceAreas`,
  the 4 stop columns, `readinessConfidence`/`readinessRationale`, and the `ghlResourceId` key column.
- Category values are messy (`Business services` vs `Business Services` — clean during import).
- Reusable: GHL custom-object read/write/catalog (`lib/ghl/records.ts`, `writeRecord.ts`,
  `customFields.getObjectKeyFieldCatalog`), the enrichment engine, the enricher-config gate UI
  (`/enrichment/[name]`), the Wix mapping-set + gate machinery (`lib/mapping/*`, `lib/wix-sync/*`).

## Decisions locked
- **GHL is source of truth**; enrich in GHL; Field Mapping syncs to Wix; map reads Wix.
- **Match/dedup key = `ghlResourceId`** (a new Wix column), matched **solely** on that going forward.
  The link is established by a one-time RECONCILE (records already exist on both sides): pair GHL↔Wix
  by slug (where present) then exact normalized name, then stamp `ghlResourceId` on the Wix row + the
  Wix `_id` into GHL `wix_resource_row_id`. Only genuine orphans (none in the dry-run) get a created
  counterpart. End state: no unlinked items on either side.
- **Prep is scripted** (Zach's choice), each step **dry-run → review → apply**. Never a wide apply
  without confirming the gate (the 2026-07-21 CMS-flood rule).
- **Reuse the readiness taxonomy + `deriveStops`** (transform stays code); the classifier gets a
  resource-flavored prompt (classify an ORG from its description + category/subcategory, not a person).
- **Gate = a `resource_status` state machine** mirroring Team's `contact.status`
  (Pending→skip · Approved→upsert+publish, write back Published · Published→update · Hidden→hide),
  `visibility: publishState`. Enricher runs on Approved (config filter), editable in `/enrichment`.

## Fields to create
**GHL `custom_objects.resources` (add):**
| key | type | notes |
|---|---|---|
| `service_areas` | MULTIPLE_OPTIONS | 29 taxonomy labels |
| `mrl_stops` | MULTIPLE_OPTIONS | "1".."10" |
| `trl_stops` / `crl_stops` / `investor_readiness_stops` | MULTIPLE_OPTIONS | "1".."9" |
| `readiness_confidence` | SINGLE_OPTIONS | High/Medium/Low |
| `readiness_rationale` | LARGE_TEXT | — |
| `resource_status` | SINGLE_OPTIONS | Pending/Approved/Published/Hidden (the sync gate) |
| `wix_resource_row_id` | TEXT | writeback of the Wix `_id` |

**Wix `Import1` (add):** `serviceAreas`, `mrlStops`, `trlStops`, `crlStops`,
`investorReadinessStops` (ARRAY_STRING); `readinessConfidence`, `readinessRationale` (TEXT);
`ghlResourceId` (TEXT, the key).

## Phases
- **A — Prep — ✅ DONE (2026-07-23).** Created 9 GHL fields (`custom_objects.resources`: service_areas,
  mrl/trl/crl/investor_readiness_stops, readiness_confidence, readiness_rationale, resource_status,
  wix_resource_row_id) + 8 Wix `Import1` columns (serviceAreas, 4 stop cols, readinessConfidence/
  Rationale, ghlResourceId). Reconcile-linked all 90↔90 (30 slug + 60 name), stamped both ways,
  0 orphans. Scripts: `resources-prep.ts` (fields/columns), `resources-link.ts` (match + stamp),
  helper `createObjectField` in `lib/ghl/customFields.ts` (v2 create needs fieldKey + parentId +
  `options:[{key,label}]`). Original plan below:
- **A — Prep (scripted, dry-run→apply, writes GHL + Wix):** (1) create the GHL fields + Wix columns
  above; (2) RECONCILE-link the existing 90↔90 (`resources-link.ts`): stamp `ghlResourceId` on each
  Wix row + `wix_resource_row_id` on each GHL record; create a counterpart only for true orphans
  (none in the dry-run). `resources-prep.ts` audits + creates fields/columns; `resources-link.ts`
  matches + stamps. OPEN: exact GHL create-custom-field v2 body — resolve from the marketplace v2 ref
  or one careful test-create; the field GET shape is `{field:{id,fieldKey,name,dataType,parentId,...}}`
  under folder `VuQMCzWXPkuNXqG2fCna`.
- **B — Resource enricher:** resource-flavored tagger (`lib/enrichment/enrichers/resourceTagger.ts`)
  + a custom-object enrich path (generalize `contactEngine` to a record engine, or `recordEngine.ts`).
  Register in the registry; gate config via `/enrichment` (sourceObject `custom_objects.resources`),
  default filter `resource_status ∈ {Approved}`. Seed the config.
- **C — Object-agnostic Wix sync:** generalize `syncContactToWix` → read a custom-object record
  (via `records.ts`) so a mapping set `custom_objects.resources → Import1` runs the gate / createPolicy
  / visibility / writeback / match-by-`ghlResourceId`. Dispatch on resource-change webhook.
- **D — Mapping set:** seed Resource → Wix `Import1` (field rows + gate), like `set-team-gate.ts`.
- **E — Embed:** add the Resources branch to `wix-embed/backend/http-functions.js` `get_providers`
  (query `Import1`, map `type:'tap'`, `serviceAreas` + stops); the map already renders the "Technical
  Assistance Providers" group. Zach pastes into Wix.
- **F — Backfill + verify:** tagger over the 90 (dry-run review), sync, confirm the map. Coverage/gap
  view (TRL 7 hole) = later.

## Definition of done
Resources managed in GHL, enriched (service tags + stops) with an editable gate, synced to the Wix
Resources CMS with create/update/visibility, and appearing on the map as TA providers at the right
stops — with the Team side unchanged. tsc + tests green; dry-run proofs before each live write; deploy.
