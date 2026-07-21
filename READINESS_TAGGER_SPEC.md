# Readiness Tagger (AI enrichment) + Subway-Map Embed — Build Brief

**Audience:** Claude Code (app work) + Zach (Wix embed).
**Status:** design brief. GHL fields + Wix columns are **already created** (this session). Prototype validated on 40 EIRs (`LRL_Readiness_Tagging_Prototype.xlsx`).

---

## 1. What this feature does

An **AI contact-enrichment** classifies each team member's profile into Brandon's 29-service taxonomy, then **derives which subway-map stops** (MRL 1–10, TRL 1–9, CRL 1–9, Investor Readiness 1–9) they should appear at. Those values live on the GHL contact, sync to the Wix **Team** CMS (Contact→Team sync already built), and the **map embed** filters people by the stop currently selected on screen.

Flow: **GHL contact → readiness-tagger enricher (Anthropic) → 7 GHL fields → Wix sync → Team CMS columns → map embed filters by stop.**

Design principle (locked with Zach): the **LLM assigns expertise (service tags); code derives stop numbers** from the tags via `STOP_SERVICES`. So if a stop's definition changes, re-derive all stop fields instantly with zero API calls; only re-call the LLM when a profile changes.

## 2. Fields already created (do not recreate)

**GHL contact fields** (folder "Form | WIX Team CMS Profile" = `8rSDnE9E7nehea0Xsn0F`):

| Field | key | id | type | options |
|---|---|---|---|---|
| Service Areas | `contact.service_areas` | `4cwXyHXVmKae5hWrZLCT` | MULTIPLE_OPTIONS | 29 taxonomy labels |
| MRL Stops | `contact.mrl_stops` | `uDrHbARvMAQttKxnKiCl` | MULTIPLE_OPTIONS | "1"–"10" |
| TRL Stops | `contact.trl_stops` | `jmZaR2m6t64l6XeWHgHA` | MULTIPLE_OPTIONS | "1"–"9" |
| CRL Stops | `contact.crl_stops` | `UhG8N7Nq5HN5AMtySbq4` | MULTIPLE_OPTIONS | "1"–"9" |
| Investor Readiness Stops | `contact.investor_readiness_stops` | `RTxPQGQbqX5dIlMaRTpf` | MULTIPLE_OPTIONS | "1"–"9" |
| Readiness Confidence | `contact.readiness_confidence` | `qMbeXSZpCmPbjKSqopug` | SINGLE_OPTIONS | High/Medium/Low |
| Readiness Rationale | `contact.readiness_rationale` | `ttiZVLC0mVBp7rZLAUH2` | LARGE_TEXT | — |
| Website Team Tags | `contact.website_team_tags` | `TCCMGrG6Pv9Lfhga0Fi0` | MULTIPLE_OPTIONS | Team / Board / EIR |

**Website Team Tags** mirrors the Wix Team `arraystring` ("Tags") column and is the **membership gate**: backfilled from Wix for all 40 (Team/Board/EIR). The tagger runs ONLY when this field contains `Team` or `EIR`; **Board-only contacts are excluded** (6 people: Martha Fuerstenau, Sean Hilbert, Nadia Abunasser, David Shirkey, Rich Collins, Jenny Rivera). NOTE: Sean Hilbert (manufacturing) & Nadia (grants/econ-dev) are Board-only in Wix, so they're excluded even though they'd be useful coaches — re-tag them EIR in Wix/GHL if they should appear.

**Wix Team columns** (collection `Team`), all created: `serviceAreas`, `mrlStops`, `trlStops`, `crlStops`, `investorReadinessStops` (ARRAY_STRING), `readinessConfidence`, `readinessRationale` (TEXT).

**Sync mapping-set rows to add** (GHL contact → Wix Team, in the Website Sync UI):
`service_areas→serviceAreas`, `mrl_stops→mrlStops`, `trl_stops→trlStops`, `crl_stops→crlStops`, `investor_readiness_stops→investorReadinessStops`, `readiness_confidence→readinessConfidence`, `readiness_rationale→readinessRationale`, `website_team_tags→arraystring` (MULTIPLE_OPTIONS→ARRAY_STRING; keeps the Wix membership Tags in sync from GHL — already backfilled). The MULTIPLE_OPTIONS→ARRAY_STRING coercion is already handled by the Wix sync's `coerceToWix`.

## 3. The enricher (`lib/enrichment/enrichers/readinessTagger.ts`)

Fits the existing pluggable `Enricher` pattern; needs the engine extended to run **contact-targeted** enrichers (current ones target company).

**Per contact, assemble input:** `job_title`, `bio` (`contact.biowho_you_are`), `company`/`companyName`, collectives, LinkedIn, website.

**Anthropic call** (Messages API, structured output via a tool / JSON schema). Recommended model: **Claude Haiku** (cheap, fast, sufficient for classification; upgrade to Sonnet if quality needs it). Env: `ANTHROPIC_API_KEY` (hang on existing `lib/ai/`).

Output schema:
```json
{ "serviceTags": ["gtm","market"], "confidence": "High|Medium|Low", "verify": false, "rationale": "one line" }
```
System prompt embeds: the 29-tag taxonomy with short definitions, Brandon's **crosswalk** ("fractional CFO"→finmodel, "patent attorney"→ip+legal, "customer discovery/I-Corps"→discovery, "DFM"→dfm, "SBIR/STTR"→grants, etc.), and the rules: explicit beats inferred; fewer, truer tags; flag `verify:true` when inferring from thin data.

**Deterministic derivation (code, not LLM):** `serviceTags → {mrl,trl,crl,irl}` stop arrays via `STOP_SERVICES` (a stop is included when the person's tags intersect that stop's needs). Then write to GHL: `service_areas` (labels), the 4 stop fields (number strings), `readiness_confidence`, `readiness_rationale`.

**Config (single source of truth):** lift `SERVICES` (29) and `STOP_SERVICES` from Brandon's `providers-db.js` into app config used by both the prompt and the derivation. (Latest copy in Google Drive › Shared drives › Claude › LRL Readiness Map.)

**Provenance/policy:** reuse enrichment provenance (source=`anthropic`, model, confidence, timestamp). These fields are AI-managed → policy `overwrite`; low-confidence rows carry `Low` + `verify` for human review. Consider a manual-lock convention if staff hand-edit.

**Triggers:** contact-changed webhook (reuse the sync webhook pattern) + nightly reconcile + a one-shot backfill CLI (`scripts-ts/readiness-tag-run.ts`) for the existing 40. Rate-limit Anthropic modestly; GHL writes ≥0.3s spacing + backoff (429s seen at 0.12s).

**Membership gate (REQUIRED):** the tagger runs ONLY when `contact.website_team_tags` contains `Team` or `EIR`. Board-only contacts are skipped entirely (no tags/stops written). This is enforced in the enricher AND mirrored in the embed query (`hasSome('arraystring', ['EIR','Team'])`).

## 4. The Wix embed — how Zach implements it on the site

Keep Brandon's `readiness-subway-map.html` rendering; swap its static `providers-db.js` for **live CMS data via a Velo HTTP function**.

**Step 1 — Velo backend** (`backend/http-functions.js`):
```js
import { ok } from 'wix-http-functions';
import wixData from 'wix-data';
export async function get_providers(request) {
  const res = await wixData.query('Team')
    .hasSome('arraystring', ['EIR','Team'])   // coaches only; excludes Board-only
    .limit(200).find();
  const providers = res.items.map(m => ({
    id: m._id, name: m.title_fld, org: m.company || '', type: 'coach',
    photo: m.image_fld || null, bio: m.bio || '', website: m.linkedIn || m.companyWebsite || '',
    services: m.serviceAreas || [],
    stops: { MRL: m.mrlStops||[], TRL: m.trlStops||[], CRL: m.crlStops||[], IRL: m.investorReadinessStops||[] }
  }));
  return ok({ headers:{'Content-Type':'application/json'}, body:{ providers } });
}
```
Exposed at `https://<site>/_functions/providers`. (Add Resources later as `type:'tap'`.)

**Step 2 — the map** fetches it instead of loading the static file:
```js
const data = await (await fetch('/_functions/providers')).json();
const PROVIDERS = data.providers;
```
**Filtering by the selected stop** becomes trivial — no overlap math needed at runtime, since stops are precomputed per person:
```js
const shown = PROVIDERS.filter(p => p.stops[activeLine].map(String).includes(String(activeStop)));
```
`STOP_SERVICES` stays only if you want to keep showing the "services needed at this stop" chips; the person↔stop placement now comes from the precomputed `stops` arrays.

**Step 3 — put it on the page:** add the map HTML as a Wix **Custom Element** or an **HTML/Embed** block on the readiness-map page. Because the fetch hits the same site's `/_functions/`, there's no CORS/API-key issue. (If you embed it on a non-Wix page later, enable CORS on the http-function.)

**Recommendation:** Velo http-function + Brandon's HTML embed (above) is the least-change, most-maintainable path. A fully native Velo repeater would mean rebuilding the subway visuals, which isn't worth it.

## 5. Suggested sequence

1. Claude Code: build the enricher + config lift + backfill CLI; set `ANTHROPIC_API_KEY`.
2. Run backfill on the 40 (review the same way as `LRL_Readiness_Tagging_Prototype.xlsx`), correct any VERIFY rows.
3. Add the 7 mapping rows to the Website Sync set → data flows to Team CMS.
4. Zach: add the Velo http-function + drop the embed on the page.
5. Later: Resources/TAP side (same tagger + a Resources embed branch), and a coverage/gap view (TRL 7 is the current hole).
