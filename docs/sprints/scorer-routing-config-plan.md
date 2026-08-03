# Plan — Make the Client Stage scorer's ROUTING front-end configurable

> Status: PLANNED, not built (Zach, 2026-08-03). Scope decision: **routing only** (routing field +
> value→path rules). Input-field bindings and the rubrics stay in code this increment.
>
> Why: for a team-run app, when the intake "business model" question moves to a different GHL field or
> its options change, that should be a front-end edit — not a code change + redeploy. Today
> `scoreCompany.routePath` hardcodes both the field (`business.business_model`) and the value→path
> keyword rules, so a form change silently sends every company to "no route" until a dev fixes it.

## Goal
Editable on the front end (admin-guarded, like gates/mappings):
1. **Routing field** — which `business.*` field carries the business-model answer (default `business.business_model`).
2. **Value → path rules** — which option value(s) map to `tech` / `service` / `both`, plus a **fallback**
   for unmatched values (default: skip the company).

Seeded with today's behavior, so **nothing changes until someone edits it**.

## Explicitly OUT of scope (this increment)
- The 18 input field bindings (`companyInputs.SCORING_INPUTS`) — stay in code. (Follow-on: same pattern,
  a bindings table + mapping-style UI, if we later choose "Routing + all 18".)
- The rubrics / scales / four dimensions / parsing — stay in code (the scoring judgment, not a binding).

## Design (mirrors the existing config surfaces)

### 1. Storage — a small dedicated store
New table `scorer_configs` + `ScorerConfigStore` modeled 1:1 on `EnricherConfigStore`
(`lib/enrichment/configStore.ts`): TTL cache, `resolve…()` that returns the stored row or the CODE
DEFAULT, never throws. Columns: `key` (const `client-stage-scorer`), `routingField` (text),
`rules` (jsonb), `fallback` (text), `version`, `updatedAt`.
- Alternative considered: overload `enricher_configs` with a JSON column. Rejected — that table's shape
  is gate groups/filters; routing is a different concern. A dedicated tiny store matches repo idiom.

### 2. Config shape
```ts
interface ScorerRoutingConfig {
  routingField: string;                                   // 'business.business_model'
  rules: Array<{ path: 'tech' | 'service' | 'both'; anyOf: string[] }>;
  fallback: 'skip' | 'both';                              // unmatched value → skip (default) or score all
}
```
Value matching reuses the existing normalize in `routePath` (underscore/space/case-insensitive,
substring) so an option KEY (`developing_a_new_product_…`) or its label both match a rule token.
CODE DEFAULT = current behavior: field `business.business_model`; rules `both:['both']`,
`tech:['developing a new product','product','tech']`, `service:['delivering or operating a service','service']`;
fallback `skip`.

### 3. Code changes
- `lib/stage/routingConfig.ts` — `resolveRoutingConfig()` (stored-or-default) + pure
  `routePathWith(value, config)`.
- `scoreCompany.ts` — keep `routePath(value)` as "route with the default config" (so existing unit
  tests are unchanged); route in `trigger.ts` / `stage-score-run.ts` via `resolveRoutingConfig()` +
  `routePathWith`. Both callers are already async, so resolving config there is free.

### 4. API — `pages/api/stage/routing-config.ts`
- `GET` → `{ config, routingFieldCandidates, options }`: the resolved config, the business object's
  SINGLE_OPTIONS fields (candidates for the routing field, from the business catalog), and the chosen
  field's option values (to build the value→path picker). Always resolvable (falls back to default).
- `PUT` (admin-guarded via `isAdmin`, same as `/api/enrichers/[name]`) → validate + upsert.
- Alternative: fold into `/api/enrichers/[name]` for `client-stage-scorer` as an extra `routing` block.
  Dedicated route is cleaner given the different shape; either works.

### 5. Front end — add a "Routing" card to `/enrichment/client-stage-scorer`
Above the existing Gate card, reusing the page's admin-secret + catalog-fetch plumbing:
- **Routing field**: dropdown of business SINGLE_OPTIONS fields (from `/api/mapping/catalogs` or the new
  GET). Changing it reloads that field's option list.
- **Value → path**: a row per option value with a Tech / Service / Both / — skip — selector.
- **Fallback**: skip (default) vs score-all-four, for values left unmapped.
- **Save** (admin secret), identical UX to "Save gate".

### 6. Validation / safety
- Warn if the chosen routing field isn't SINGLE_OPTIONS.
- Warn when option values are left unmapped (they hit the fallback).
- Never throws on read (code-default fallback), so a bad/missing row degrades to today's behavior.

### 7. Tests
`routePathWith` (rules → path, normalization on key vs label, fallback), config resolve/default,
PUT sanitize/validation.

### 8. Migration
One new table → `npm run db:generate` + `db:push` (Neon/Postgres). No data backfill (default seeds behavior).

## Effort
Moderate — comparable to the enricher-gate config feature already in the app: 1 store + 1 API route +
1 UI card + config-aware routing + tests + 1 migration.

## Open questions
- Dedicated `scorer_configs` table vs. fold routing into `enricher_configs` (leaning dedicated).
- Do we also want the **fallback** exposed in the UI now, or hardcode `skip` and add later?
- Follow-on appetite for the 18 input bindings (the "full form-decoupling" option) once routing lands.
