# Sprint spec — Configurable gating (UI-editable enricher & sync gates)

**Status:** ready to build (spec)
**Author:** drafted with Claude
**Owners:** Zach (product) · engineering
**Motivation:** the 2026-07-21 CMS-flood incident — a `/wix-sync` UI save silently nulled the sync gate
because the UI doesn't manage it. Gates are engine-critical but invisible/uneditable in the app. Also:
enricher gates live only in code, and the readiness enricher's gate can't be seen or changed in the UI.

## Principle (locked with Zach)
- **Transforms stay in code** (the AI prompt/taxonomy, `deriveStops`, coercion). Do NOT make these config.
- **Routing + gating become config, editable in the UI**: which trigger, what condition/gate, what action.
  This is the generic "how objects communicate" layer.

## Current state (build the delta)
- **Sync gates** are ALREADY config-as-data on `WixMappingSet` (`gate`, `visibility`, `writebackField`,
  `secondaryMatch`, `createPolicy`) in Postgres. Engine reads them live (`lib/wix-sync/sync.ts`
  `resolveAction`). Gap = **no UI** to view/edit them; `sanitizeWixSet` drops them. Guardrail already
  shipped: `wixStore.saveSet` PRESERVES them when omitted (so a UI without the fields can't null them).
- **Enricher gates** are in CODE: readiness tagger's membership gate (`passesMembershipGate`, Team/EIR)
  + the status gate (`ENRICH_ON_STATUS = {Approved}` in `lib/wix-sync/pipeline.ts`, mirrored in the CLI
  `--status`). The `/enrichment` page lists enrichers from a HARDCODED array (now includes readiness,
  read-only) — not the real registry, and no gate editing.

## Phase 1 — Surface + edit SYNC gates in `/wix-sync` (smallest, highest value)
No data-model change (fields already exist). Just UI + save plumbing.
1. **`lib/mapping/wixSanitize.ts`**: pass through `gate`, `visibility`, `writebackField`, `secondaryMatch`,
   `createPolicy` from the request body when present (validate shapes). Keep the saveSet preserve-guardrail.
2. **`pages/wix-sync.tsx` editor** (+ `pages/api/wix/sets/[id].ts` already saves): add a "Gate & visibility"
   panel — pick the gate field (from the source object's field catalog), a value→action table
   (upsert/update/hide/skip), `onPublishSetStatus`, `visibility` mode, `writebackField`, `createPolicy`.
   Show the current values (read from the set the API already returns).
3. Acceptance: editing rows in the UI no longer risks the gate (guardrail), AND the gate is visible/editable.
   Regression test in `lib/mapping/__tests__`: saveSet preserves gate when omitted; sets it when provided.

## Phase 2 — Enricher gates as config
1. **DB:** add `enricher_configs` (Drizzle, `lib/db/schema.ts`): `{ id, enricher (name), sourceObject,
   enabled, gate: jsonb {field, runOn: string[]} | null, membership: jsonb {field, anyOf: string[]} | null,
   updatedAt }`. Store class `lib/enrichment/configStore.ts` (mirror `WixMappingStore`, TTL cache).
2. **Refactor gating out of code into config-read:**
   - `readinessTagger.enrich` keeps the transform; REMOVE the hardcoded membership gate from it.
   - `lib/wix-sync/pipeline.ts` + `scripts-ts/readiness-tag-run.ts`: read the enricher's config (status
     `runOn` + `membership.anyOf`) to decide whether to run, instead of `ENRICH_ON_STATUS` + `passesMembershipGate`.
   - Keep a code default so a missing config = today's behavior (Approved + Team/EIR). Seed via a script
     (like `set-team-gate.ts`) so live behavior is unchanged on deploy.
3. **API + UI:** `pages/api/enrichers/*` (list registry + get/put config); make `/enrichment` registry-driven
   (list real `defaultEnrichers` + `defaultContactEnrichers`, each with an editable gate panel like the sync one).
4. Acceptance: change the readiness gate (e.g. add `Published` to runOn, or `Board` to membership) in the UI
   → next run honors it, no code change. Dry-run proves it.

## Phase 3 — Generic rules layer (later)
Unify sync + enrich under one "trigger → condition → action" model over a catalog of connected systems/objects
(GHL, Wix). A rule = `{ on: object-changed, if: gate, do: [sync set X | enrich Y] }`. The Phase-1/2 gate
shapes are the building blocks; this is the "no code per use case" endpoint.

## Guardrails / notes
- Reuse ONE gate shape across enrichers + syncs where possible (field + value→action / runOn).
- Any field pickers read the live catalog (`getCatalog`/`getContactFieldCatalog`) — don't hardcode field lists.
- Watch for the concurrent-writer situation in this repo; rebase before big edits.
- Prereq already done: `saveSet` preserve guardrail (commit 3efbba8).
