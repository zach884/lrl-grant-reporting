# Operationalizing the Sync — Deploy Handoff

The sync **engine** is built + validated (down-sync applied live; up-sync + real-time
fan-out proven on sandbox). What remains is **deployment + wiring**, best done in Claude
Code on your machine (a persistent env + `vercel` CLI). Here's the turnkey checklist.

## What's built
- **Up-sync + real-time loop:** `pages/api/sync/up.ts` — a secret-guarded webhook. On a
  contact change it pushes mapped fields UP to the contact's company (equality-guarded),
  and if the company actually changed, fans the new state DOWN to the company's other
  contacts (roster via the associations graph). Idempotent + loop-safe (validated).
- **Down-sync batch/backstop:** `scripts-ts/reconcile-run.ts` (already used live; runs nightly
  via GitHub Action — see "Schedule the reconcile").
- **Mapping source of truth = Postgres** (edited at `/mappings`). `config/field-mappings.json`
  is now just a git-tracked **snapshot** (regenerate with `npm run db:dump`) — see
  "Editable mapping store".

## Deploy steps (Vercel)
1. `vercel link` this app, then set env vars (Production):
   - `GHL_API_KEY` = live Private Integration token
   - `GHL_LOCATION_ID` = `FgnVVv4smxyBNJKFZgJv`
   - `GHL_TARGET` = `live`
   - `SYNC_WEBHOOK_SECRET` = a long random string (the webhook guard)
   - (existing Google/Sheets vars as already in `.env.local`)
2. `vercel --prod` → note the deploy URL.
3. Smoke test (dry run, no writes):
   `curl -X POST "https://<app>/api/sync/up?dryRun=1" -H "x-webhook-secret: <SECRET>" -H "Content-Type: application/json" -d '{"contactId":"<a real contact id>"}'`
   → expect `{ ok:true, up:{...}, down:{...} }`.

## Wire the GHL workflow (one workflow, no per-field triggers)
- Trigger: **Contact Changed** (broad — no per-field filters needed; the sync is
  equality-guarded so over-firing is harmless).
- Action: **Webhook** → `POST https://<app>/api/sync/up`
  - Header `x-webhook-secret: <SYNC_WEBHOOK_SECRET>`
  - Header `x-vercel-protection-bypass: <bypass token>` — **required** while Vercel Deployment
    Protection is on, or Vercel returns 401 before the app runs. (Generate under Settings →
    Deployment Protection → Protection Bypass for Automation.)
  - Body (JSON): `{ "contactId": "{{contact.id}}" }`
- Publish. That's it — a new synced field later = one row added at `/mappings`, no workflow change.

## Schedule the reconcile (nightly backstop)
The full sweep over ~860 companies exceeds a serverless function's time budget, so it runs as a
**GitHub Action** (`.github/workflows/nightly-reconcile.yml`), not a Vercel cron:
`GHL_TARGET=live npx vite-node scripts-ts/reconcile-run.ts --apply --yes --resume` (07:00 UTC
nightly; also `workflow_dispatch` for manual runs). Idempotent + equality-guarded, so a clean
night writes nothing; it reads live mappings from Postgres.
- **Required GitHub repo secrets** (Settings → Secrets and variables → Actions): `GHL_API_KEY`,
  `GHL_LOCATION_ID`, `GHL_CUSTOM_OBJECT_ID`, `DATABASE_URL` (same values as `.env.local`/Vercel).

## Notes / decisions
- **Direction policy:** up-sync honors `direction` in the mapping (`up`/`both`). Today 32
  fields are `both`, so a contact edit propagates up to the company (last-edit-wins). To
  keep a firmographic company-authoritative (contact edits corrected, not pushed up),
  set that row to `down`.
- **Company multi-select** fields are skipped by up-sync (API can't update them) — those
  use the native workflow-enroll path.
- **Mapping edits in prod** are now editable in-app — see "Editable mapping store" below.
  (The committed `config/field-mappings.json` remains the seed artifact.)

## Editable mapping store (DB-backed) + `/mappings` UI
The mapping table now lives in **Postgres** (Vercel/Neon), edited via a visual builder at
**`/mappings`** — no redeploy to change a mapping.
- **Store selection:** `lib/mapping/store.ts` picks `DbMappingStore` when `DATABASE_URL`
  (or `POSTGRES_URL`) is set, else the file store (local scripts/tests). The sync engine is
  unchanged — it still receives a `FieldMapping[]`.
- **Env vars:**
  - `DATABASE_URL` (or `POSTGRES_URL`) — auto-injected by the Neon/Vercel Postgres integration.
  - `SYNC_WEBHOOK_SECRET` — webhook guard (unchanged).
  - `ADMIN_SECRET` — guards the editor's write endpoint (`POST /api/mapping/[slug]/save`,
    header `x-admin-secret`).
- **Provision / seed (one-time):** attach Neon in the Vercel Storage tab, then locally with
  `DATABASE_URL` in `.env.local`:
  `npm run db:push` (create tables) → `npm run db:seed` (load `config/field-mappings.json`).
  Local + prod share one Neon DB, so this seeds prod too.
- **Snapshot / source of truth:** the **DB is authoritative**; `config/field-mappings.json` is a
  git-tracked snapshot for history + re-seeding. Refresh it from the DB anytime with
  `npm run db:dump`. When `DATABASE_URL` is set, the file is NOT read at runtime.
- **Note:** the webhook caches mappings for 10 min; a UI save invalidates that cache so
  changes go live immediately.
