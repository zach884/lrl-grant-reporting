# GHL → Wix CMS Field-Mapping & Sync — Build Brief

**Audience:** Claude Code, working in the `lrl-grant-reporting/` Next.js app.
**Status:** **Phase 1 BUILT** (2026-07-16) — Contact → Wix collection sync, additive to the
existing contact↔company sync. Awaiting Wix OAuth credentials for live verification.

### Implementation status (Phase 1)

Built and green (tsc + 19 new unit tests + `next build`):
- **DB:** `wix_mapping_sets` + `wix_mapping_rows` (additive; `lib/db/schema.ts`) + `WixMappingStore`
  (`lib/mapping/wixStore.ts`). Run `npm run db:push` to create the tables (writes the prod DB).
- **Connector:** `lib/wix/` — OAuth client-credentials token manager (`config.ts`/`client.ts`),
  `collections.ts` (query/insert/bulk-patch/create-field/replace-references), `media.ts`
  (import file → Media Manager), `coerce.ts` (`coerceToWix`, all Team types incl. IMAGE + refs).
- **Engine:** `lib/wix-sync/` — `syncContactToWix` (match-key upsert, idempotent, image + reference
  passes, dry-run).
- **Trigger + backfill:** `POST /api/wix-sync` (webhook, `WIX_SYNC_WEBHOOK_SECRET`) +
  `npm run wix:sync` (`scripts-ts/wix-sync-run.ts`).
- **UI:** `/wix-sync` mapping-set editor (nav: "Website Sync") + `pages/api/wix/*` routes.

**Prerequisites before live writes (Zach):** create a Wix OAuth app (Wix Data + Media scopes),
install it on the LRL site, and set `WIX_OAUTH_CLIENT_ID`, `WIX_OAUTH_CLIENT_SECRET`,
`WIX_APP_INSTANCE_ID`, `WIX_SITE_ID`, `WIX_SYNC_WEBHOOK_SECRET` in `.env.local` + Vercel +
GitHub secrets. IMAGE + MULTI_REFERENCE coercion is best-effort per docs and needs one live
pass to confirm the exact value shapes.

**Live Team schema confirmed** (2026-07-16): collection id `Team`, match key `ghlContactId`,
`program` → `Programs`, `collectives` → `Collectives` (both MULTI_REFERENCE).

---

## 0. Kickoff prompt (paste this into Claude Code)

> Extend our field-mapping module into a generalized **GHL → Wix CMS sync**. Today it maps GHL contact↔company fields; I want to add **Wix CMS collections as a write target**. Build a config-driven "mapping set" where I pick a GHL source **object** (Contact now; Company and custom objects soon) and, per row, a GHL **field** on the left, mapped to a column on **one** Wix CMS collection I choose on the right. Each mapping set writes to exactly one Wix collection. Sync direction is outbound (GHL → Wix) only for v1. A GHL workflow will fire a webhook that runs the mapping set and upserts the matching Wix row. Start with **Contact → the Wix "Team" collection**, which already has data and a `ghlContactId` key column. Read `WIX_CMS_SYNC_SPEC.md` for the full data model, the Wix Data API shapes, the type-coercion rules, and the phased scope.

---

## 1. Objective

Let LRL map any GHL object's fields to any single Wix CMS collection and keep the Wix rows in sync from GHL, driven by config (not code) and a simple two-column UI.

- **Now:** GHL **Contact** fields → a chosen Wix CMS collection.
- **Soon:** GHL **Company** (`business` object) → Wix CMS; GHL **custom objects** (`custom_objects.<key>`) → Wix CMS.
- **Rule:** each mapping set targets **exactly one** Wix collection.
- **Direction:** outbound only (GHL → Wix) for v1. (Inbound Wix→GHL was done once as a manual backfill; not part of this feature.)

## 2. Build on what already exists (do NOT start from scratch)

The app already has (see `lib/`):
- `lib/ghl/` — `GhlClient` (auth, Version header, UA, 429/5xx backoff, global token-bucket rate limiter `GHL_MAX_RPS`, pagination), typed errors, `coerce.ts` for GHL field types, resource helpers (businesses/contacts/customFields/associations).
- `lib/mapping/` — config-as-data `FieldMapping` table (currently `contactKey ↔ businessKey`, `direction`, `transform`), live-catalog `resolve`/`validate`/`suggest`, `FileMappingStore` (`config/field-mappings.json`).
- `lib/sync/` — down/up sync + reconcile sweep, equality-guarded/idempotent, webhook `pages/api/sync/up.ts` pattern.
- `lib/enrichment/`, `lib/dedup/` — pluggable enrichers, LARA-ID dedup.

This feature = **generalize the mapping model** to arbitrary source/target endpoints and **add a Wix "sink"** next to the GHL client. Reuse the webhook-trigger pattern and the catalog/resolve/validate machinery.

## 3. Generalized mapping data model

Replace the contact↔business-specific `FieldMapping` with a system-agnostic **MappingSet**:

```ts
type SystemRef =
  | { system: 'ghl'; object: 'contact' | 'business' | `custom_objects.${string}` }
  | { system: 'wix'; siteId: string; collectionId: string };

interface MappingRow {
  sourceFieldKey: string;   // GHL field key/id for the chosen object
  targetColumnKey: string;  // existing Wix column key on the chosen collection
  transform?: string;       // optional (e.g. 'html', 'arrayFromMultiSelect', 'imageToWixMedia', 'countryCode')
  policy?: 'fill-empty' | 'overwrite'; // default overwrite for outbound
}

interface MappingSet {
  id: string;
  name: string;
  source: Extract<SystemRef, { system: 'ghl' }>;
  target: Extract<SystemRef, { system: 'wix' }>;   // exactly one Wix collection
  matchKey: { sourceField: string; targetColumn: string }; // upsert key, e.g. contact id ↔ ghlContactId
  rows: MappingRow[];
  enabled: boolean;
}
```

- One `MappingSet` → one Wix collection (per requirement).
- `matchKey` is how a source record finds/creates its Wix row (see §6).
- Keep it config-as-data; persist via a store (see Open Decisions re prod persistence).

## 4. Wix connector (`lib/wix/`) — new

Add a `WixClient` mirroring `GhlClient`. **Wix API base:** `https://www.wixapis.com`. All calls need `Authorization: Bearer <token>` and JSON `Content-Type` on bodies.

**Endpoints (all verified working this session):**
- List collections: `GET /wix-data/v2/collections` (light: `?fields=displayName`).
- Collection schema: `GET /wix-data/v2/collections/{collectionId}` → `fields[]` `{key, displayName, type, typeMetadata}`.
- Query items: `POST /wix-data/v2/items/query` body `{ dataCollectionId, query:{ filter, sort, paging|cursorPaging }, includeReferencedItems:[...] }`.
- Get item: `GET /wix-data/v2/items/{id}?dataCollectionId={id}`.
- Insert: `POST /wix-data/v2/items` `{ dataCollectionId, dataItem:{ data:{...} } }`.
- **Bulk PATCH (partial — PREFER THIS for updates):** `POST /wix-data/v2/bulk/items/patch` `{ dataCollectionId, patches:[{ dataItemId, fieldModifications:[{ fieldPath, action:'SET_FIELD', setFieldOptions:{ value } }] }] }`. Actions: `SET_FIELD`, `REMOVE_FIELD`, `INCREMENT_FIELD`, `APPEND_TO_ARRAY`, `REMOVE_FROM_ARRAY`.
- Bulk update (replaces whole item — avoid unless intended): `POST /wix-data/v2/bulk/items/update`.
- Add a column (for the match-key column): `POST /wix-data/v2/collections/create-field` `{ dataCollectionId, field:{ key, displayName, type, typeMetadata?, description } }`.
- References (MULTI_REFERENCE — **cannot** be set via insert/update/patch): `POST /wix-data/v2/bulk/items/insert-references`, `POST /wix-data/v2/items/replace-references` `{ dataCollectionId, referringItemId, referringItemFieldName, newReferencedItemIds:[...] }`, `.../remove-references`.

**Auth:** the app currently has **no** Wix credentials (Wix was reached only via the Wix MCP connector during backfill). Claude Code needs a Wix API token (API key or OAuth app with **Wix Data** + **Media Manager** scopes) in env, e.g. `WIX_API_TOKEN`, `WIX_SITE_ID`. **This is a prerequisite Zach must provision.** LRL site id = `65e70070-9e36-4105-99b8-436ce90376d7`.

## 5. Type coercion (GHL field type → Wix column type)

Analogous to the existing GHL `coerce.ts`. Build a `coerceToWix(value, ghlType, wixColumnType, transform)`:

| GHL source | Wix target | Rule |
|---|---|---|
| TEXT / LARGE_TEXT | TEXT | passthrough |
| LARGE_TEXT | RICH_TEXT | wrap as HTML (`<p>…</p>`) |
| NUMERICAL | NUMBER | numeric |
| SINGLE_OPTIONS (stores label) | TEXT | label passthrough |
| SINGLE_OPTIONS | REFERENCE | resolve label → referenced-collection item id; set id |
| MULTIPLE_OPTIONS (labels[]) | ARRAY_STRING | array of strings (easy) |
| MULTIPLE_OPTIONS | MULTI_REFERENCE | resolve each label → ref item id, set via reference endpoints (post-upsert) |
| DATE | DATETIME | `{ "$date": "…T00:00:00Z" }` (full ISO) |
| EMAIL | EMAIL / TEXT | passthrough |
| URL / website scalar | URL | normalize scheme |
| FILE_UPLOAD (GHL file url) | IMAGE | download file from GHL, **import to Wix Media Manager** (Import File API → `wix:image://…` URI), set the URI |
| standard scalars (name/phone/address) | TEXT | passthrough |

**Notes learned this session:**
- GHL FILE_UPLOAD values read back as an array of objects `[{ url, documentId, meta:{ originalname, mimetype, size, uuid } }]` (or plain url strings on older data). To display in GHL they must be written as the object shape — irrelevant for Wix, but relevant if reading them.
- MULTI_REFERENCE is the trickiest: it needs a two-step (upsert the row, then set references via the reference endpoints) and requires resolving option labels to the target reference collection's item ids.
- Wix `includeReferencedItems:["col1","col2"]` expands references on read.

## 6. Match / upsert key

Each target Wix collection needs a **key column holding the GHL record id** so sync is an idempotent upsert (not blind insert).

- Convention: `ghlContactId` (contacts), `ghlCompanyId` (business), `ghlRecordId` (custom objects). The **Team** collection already has `ghlContactId` (added this session).
- Sync per source record: `query` the Wix collection filtered by `{ [matchKey.targetColumn]: <source id> }` → if found, **bulk patch** that row; if not, **insert** a new row (with the key column set). This makes the whole thing re-runnable/idempotent.
- If the collection lacks the key column, offer to create it via `create-field` (TEXT).

## 7. Sync flow & trigger

- **Trigger:** GHL workflow ("Contact Changed" / "Company Changed") → webhook `pages/api/wix-sync.ts` (secret-guarded, `?dryRun=1`), body `{ object, recordId }`. Mirror the existing `/api/sync/up` pattern.
- **Run:** load enabled MappingSets whose `source.object` matches → for each: read source record fields (GHL) → coerce per rows → upsert target Wix row by matchKey → handle MULTI_REFERENCE/IMAGE side-writes.
- **Batch/backfill:** a CLI (like `scripts-ts/reconcile-run.ts`) to run a MappingSet across all source records, resumable + rate-limited.
- **Rate limits:** GHL bulk loops hit **429 at ~0.12s spacing** — keep ≥0.3s + exponential backoff (the client's token bucket + retry should cover it). Wix bulk endpoints let you batch many rows per call (prefer bulk patch).

## 8. UI spec — two-column mapper

A "Mapping Set" editor page:

- **Header:** Source = GHL (fixed) + **Object dropdown** (Contact / Company / Custom Object → picks the GHL catalog). Target = Wix **Site** (if >1) + **one Collection dropdown** (from `GET /collections`).
- **Match-key row:** pick source field ↔ target column (defaults to the `ghl*Id` column).
- **Mapping rows:** each row = **[GHL field dropdown]** (populated from the selected object's field catalog) → optional **[transform]** (auto-suggested from the type pair) → **[Wix column dropdown]** (existing columns of the chosen collection, with type shown; flag incompatible pairs). Add/remove rows.
- **Actions:** Save, **Dry-run** (show what would be written per row), Run, and an enable toggle. List saved mapping sets.
- Left side reuses the existing GHL catalog/`resolve`; right side reads the Wix collection schema. Auto-suggest row pairs by name similarity (reuse `suggest`).

## 9. Phased scope

- **Phase 1 (start here):** Contact → **Team** collection. Types: TEXT, NUMBER, URL, EMAIL, DATE, ARRAY_STRING, single-select, IMAGE (via Wix media import). Upsert by `ghlContactId`. Wire one GHL "Contact Changed" webhook + a backfill CLI. Team already has real data + the key column, so it's the cleanest proving ground.
- **Phase 2:** Company (`business`) source → a Wix collection (e.g. a companies/clients CMS); add `ghlCompanyId` key column.
- **Phase 3:** Custom objects (`custom_objects.<key>`) source.
- **Later:** MULTI_REFERENCE target support (Collectives/Programs), scheduled reconcile, prod-grade mapping persistence, per-row conflict policy UI.

## 10. Open decisions (Zach to confirm)

1. **Wix auth:** API key vs OAuth app — and provision it (Wix Data + Media scopes) into the app env.
2. **Mapping config persistence in prod:** the current `FileMappingStore` is dev-only on Vercel (read-only FS) → needs a DB/KV store.
3. **Conflict policy default:** overwrite (Wix mirrors GHL) vs fill-empty, per mapping set/row.
4. **Multi-value fields:** ship ARRAY_STRING first; treat MULTI_REFERENCE as a later enhancement.

## 11. Reference: what a Wix collection looks like (Team, live)

Fields incl.: `title_fld` (Name, TEXT), `bio` (TEXT), `email` (EMAIL), `linkedIn`/`companyWebsite` (URL), `image_fld`/`companyLogo` (IMAGE, `wix:image://…`), `description_fld` (RICH_TEXT), `program`/`collectives` (MULTI_REFERENCE → Programs/Collectives collections), `arraystring` (ARRAY_STRING = membership tags), `ghlContactId` (TEXT, our key). Resources collection (`Import1`) is the TAP analog.
