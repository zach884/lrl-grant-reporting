# Wix embed — Startup Readiness Map (live CMS)

These two files replace Brandon's static prototype (`providers-db.js` + `readiness-subway-map.html`)
with a version that pulls coaches **live from the Team CMS**. Claude Code can't deploy to Wix, so
paste these in yourself. (Both are fleshed out from the starter snippets in `READINESS_TAGGER_SPEC.md`.)

## What changed vs. the prototype

- `PROVIDERS` is no longer a static file. The map `fetch()`es `/_functions/providers` (a Velo
  backend function) and renders whatever the Team CMS returns.
- Each person's **subway stops are precomputed** (written by the readiness-tagger, synced GHL → Team
  CMS). So the map places a coach at a stop with `p.stops[line].includes(stop)` — no runtime tag math.
- `SERVICES` + `STOP_SERVICES` are still inlined in the HTML (they drive the "services needed at this
  stop" chips and tag highlighting). Keep them in sync with `lib/enrichment/data/readiness.ts`.

## Files

| File | Where it goes in Wix |
|---|---|
| `backend/http-functions.js` | Velo **Backend → `backend/http-functions.js`** (merge `get_providers` in if the file exists). Exposes `GET /_functions/providers`. |
| `readiness-subway-map.html` | An **HTML/Embed** element (or Custom Element) on the readiness-map page. |

## Install steps

1. **Enable Dev Mode (Velo)** in the Wix Editor.
2. **Backend:** open `backend/http-functions.js` and paste in `get_providers` (and the helpers).
   Confirm the `FIELDS` map matches your Team collection's field ids
   (see `WIX_CMS_SYNC_SPEC.md` §11 — `title_fld`, `company`, `image_fld`, `bio`, `linkedIn`,
   `companyWebsite`, `serviceAreas`, `mrlStops`, `trlStops`, `crlStops`, `investorReadinessStops`,
   `arraystring`).
3. **Publish** the site, then check the JSON: open `https://<your-site>/_functions/providers` — you
   should see `{ "providers": [ … ] }`.
4. **Page:** add an HTML/Embed block on the readiness-map page and paste
   `readiness-subway-map.html`. Because the fetch hits the same site's `/_functions/`, there's no
   CORS or API-key setup.

## Prerequisites (data)

The map only shows coaches once the readiness-tagger has run and the sync has pushed the fields to
the Team CMS:

1. Run the tagger backfill (`scripts-ts/readiness-tag-run.ts`) and review the dry-run.
2. Add the readiness sync rows (`scripts-ts/seed-readiness-mapping.ts --apply`) so
   `serviceAreas` + the four stop columns flow GHL → Team CMS.
3. Sync the Team contacts (`npm run wix:sync -- --apply --yes`) or let the nightly sync run.

`get_providers` filters to `hasSome('arraystring', ['EIR','Team'])` (Board-only excluded) and hides
rows that don't yet have any stops, so the map stays clean while the backfill is in progress.

## Notes

- **Photos:** `image_fld` is stored as a `wix:image://…` URI. `toStaticImageUrl()` converts it to a
  public `https://static.wixstatic.com/media/…` URL so the `<img>` renders; unrecognized/empty values
  fall back to an initials avatar.
- **Non-Wix embed:** if you ever host the map off-Wix, uncomment the
  `Access-Control-Allow-Origin` header in `http-functions.js`.
- **Resources / TAP side (later):** add a second query against the Resources collection mapped with
  `type:'tap'` and concat into `providers` — the map already renders a separate "Technical Assistance
  Providers" group.
