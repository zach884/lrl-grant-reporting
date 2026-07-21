# Sprint — Readiness Map (AI tagger + gated Contact→Team sync + Wix embed)

**Status:** ✅ SHIPPED & LIVE (2026-07-21)
**Author:** built with Claude
**Owners:** Zach (product) · engineering
**Full design + implementation log:** `../../READINESS_TAGGER_SPEC.md`

## Goal
Auto-classify each LRL team member's profile into Brandon's 29-service taxonomy, derive their subway-map
stops, sync to the Wix Team CMS, and render a live subway-map embed. LLM assigns expertise tags; code
derives stops. GHL bio is the source of truth.

## Shipped
- **Enricher** (`lib/enrichment/`): `data/readiness.ts` (SERVICES + STOP_SERVICES + `deriveStops`),
  `contactEngine.ts` (contact-targeted engine), `enrichers/readinessTagger.ts` (Claude Haiku, temp 0,
  Team/EIR gate). 26 unit tests; dry-run matched 32/34 vs the prototype.
- **Unified trigger**: `lib/wix-sync/pipeline.ts` `runContactTeamPipeline` (enrich-on-Approved → sync),
  folded into `/api/sync/up` so ONE "Contact Changed" webhook drives everything. Nightly backstop
  `.github/workflows/nightly-readiness.yml` (`--status Approved`).
- **Gate** (Zach's state machine) on the Contact→Team set: `Pending→skip · Approved→upsert+enrich→
  write-back Published · Published→update · Hidden→hide`; `visibility: publishState`; writeback →
  `contact.wix_team_row_id`. Configured via `scripts-ts/set-team-gate.ts`.
- **Data**: 40 team-page contacts migrated `On Website→Published`, tagged, and synced with full fields
  (readiness + photos/bio/company/website/collectives). Verified end-to-end through the live webhook.
- **Embed**: `wix-embed/` (Velo `get_providers` + subway map fetching live CMS by precomputed stop).

## Incident (resolved) — UI save wiped the gate
The `/wix-sync` editor save (`sanitizeWixSet`) omits gate/visibility/writeback; `saveSet` nulled them →
`find_or_create` flooded the CMS with **1,391 junk DRAFT rows**. **Fix:** `wixStore.saveSet` now preserves
those fields when omitted (undefined = keep, null = clear). Junk deleted via
`scripts-ts/cleanup-junk-team-rows.ts`. Re-run confirmed `insert=0`. (A separate "board bios wrong" report
was a Wix front-end dynamic-binding bug, not the data.)

## Open items / next
1. **Configurable gating layer (priority).** UI to view/edit enricher AND sync gates (enrichers stay code).
   `/enrichment` page is a hardcoded company-only brochure today — surface the real registry + gates.
   Toward a generic "how objects communicate" rules layer. The gate-wipe incident motivates it.
2. **Alyssa Marken** — Team-tagged DRAFT Wix row, no `ghlContactId` (unlinked). Link or publish, or ignore.
3. **`program` reference resolver** — make case-insensitive (`Local` ≠ `LOCAL`).
4. **Resources/TAP side** — same tagger + `get_providers` branch (`type:'tap'`) + coverage/gap view (TRL 7 hole).

## Key scripts
`readiness-tag-run.ts` (backfill/nightly; `--status`/`--all-status`/`--rederive`) ·
`set-team-gate.ts` (gate config) · `migrate-contact-status.ts` · `seed-readiness-mapping.ts` ·
`cleanup-junk-team-rows.ts` · `wix-sync-run.ts` (backfill).
