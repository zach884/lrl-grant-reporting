# Sprint spec — Configurable gating (UI-editable enricher & sync gates)

**Status:** SCOPED — ready to build. **Committed scope = P1 + P2** (full configurable gating: sync-gate
editor + enricher-gate config & editor). **P3 (generic rules layer) is future/vision, not this sprint.**
**Author:** drafted with Claude
**Owners:** Zach (product) · engineering
**Hand-off:** built in a fresh chat — see the **Kickoff prompt** at the bottom.
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

## Decisions locked (2026-07-21)
- **Build P1 + P2 together** as one feature/deploy. P3 is out of scope this sprint.
- **One shared "Gate editor" component + shape** reused by both sync gates and enricher gates
  (a field picker sourced from the live catalog + a value→action table for syncs / value-list for
  enrichers). Don't build two parallel UIs.
- **Enricher gates live in a new `enricher_configs` table** (mirror `WixMappingStore`). Engine reads
  config; **falls back to today's hardcoded behavior when no row exists**, and a seed script writes the
  readiness enricher's current gate (status `runOn:['Approved']`, membership `anyOf:['Team','EIR']`) so
  the cutover changes nothing.
- **Edits are admin-guarded** (`isAdmin`), like the existing mapping routes.
- **Field/value pickers read the live catalog** (`getCatalog`/`getContactFieldCatalog`) — never hardcode.
- **Transforms stay code** (AI prompt/taxonomy, `deriveStops`, coercion). Only when/where/gate is config.

## Definition of done (P1 + P2)
1. In `/wix-sync`, the Contact→Team set's gate/visibility/writeback/createPolicy are **visible and editable**,
   and saving rows never drops them (guardrail + sanitize passthrough). Verified: set gate via UI → engine honors it.
2. In `/enrichment`, the **readiness tagger is registry-driven** (not hardcoded) and its gate (status + membership)
   is **editable**; changing it (e.g. add `Published` to runOn) changes what the next run does — proven with a dry-run.
3. Seed keeps live behavior identical on deploy. `tsc` clean; unit tests incl. a saveSet-preserve regression and an
   enricher-config read test. Deploy to prod (branch = Vercel prod).

## Kickoff prompt (paste into the new chat)
> Read `docs/sprints/configurable-gating.md`, `READINESS_TAGGER_SPEC.md`, and `WIX_CMS_SYNC_SPEC.md`.
> Build **P1 + P2** of configurable gating: make sync gates editable in `/wix-sync` and enricher gates
> editable in `/enrichment`, sharing one Gate editor component. Enricher gates go in a new
> `enricher_configs` table (Drizzle) with an engine read that falls back to current hardcoded behavior
> when absent; seed the readiness enricher's current gate (Approved + Team/EIR) so nothing changes on
> cutover. Keep transforms in code. Admin-guard edits; field pickers read the live catalog. Follow the
> existing patterns: `lib/mapping/wixStore.ts` + `pages/api/wix/sets/[id].ts` + `pages/wix-sync.tsx` for
> the sync side; `lib/enrichment/` + `lib/wix-sync/pipeline.ts` (`ENRICH_ON_STATUS`) +
> `scripts-ts/readiness-tag-run.ts` (`--status`) for the enricher side. NOTE: a second process was
> recently committing to this repo — `git fetch` and rebase before large edits. Ship: tsc + tests green,
> dry-run proof that editing a gate in the UI changes engine behavior, then deploy (push to the default
> branch = Vercel prod). Do NOT run a wide `wix-sync` apply without confirming the gate is set (an ungated
> run once flooded the CMS with 1391 rows — see the incident note in READINESS_TAGGER_SPEC.md).
