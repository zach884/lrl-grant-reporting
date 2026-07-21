/* wix-embed/backend/http-functions.js — Velo backend for the Startup Readiness Map.
 *
 * Exposes GET https://<your-site>/_functions/providers → JSON { providers: [...] } that the
 * readiness-subway-map embed fetches instead of the old static providers-db.js.
 *
 * It queries the Team CMS collection, filtered to coaches only (rows whose membership Tags
 * contain "EIR" or "Team" — Board-only people are excluded, mirroring the tagger's gate), and
 * maps each row to the provider shape the map expects, INCLUDING the precomputed subway stops
 * (serviceAreas + the four stop arrays are written by the readiness-tagger, synced from GHL).
 *
 * HOW TO INSTALL: in the Wix Editor, enable Dev Mode (Velo), open Backend, and put this file at
 * backend/http-functions.js (merge get_providers in if you already have that file). Publish the
 * site. The function is then live at /_functions/providers. No API key or CORS needed because the
 * embed is served from the same site. (To embed the map on a NON-Wix page later, uncomment the
 * CORS header block below.)
 */

import { ok, serverError } from 'wix-http-functions';
import wixData from 'wix-data';

/* Team CMS field ids (from WIX_CMS_SYNC_SPEC.md §11). Adjust here if your collection differs. */
const COLLECTION = 'Team';
const FIELDS = {
  tags: 'arraystring',            // membership tags (ARRAY_STRING): EIR / Team / Board
  name: 'title_fld',
  org: 'company',
  photo: 'image_fld',
  bio: 'bio',
  linkedIn: 'linkedIn',
  website: 'companyWebsite',
  serviceAreas: 'serviceAreas',   // ARRAY_STRING of service LABELS
  mrl: 'mrlStops',
  trl: 'trlStops',
  crl: 'crlStops',
  irl: 'investorReadinessStops',
};

/* Convert a Wix media URI (wix:image://v1/<id>~mv2.<ext>/<file>#...) to a public static URL so
 * the map's <img> can render it. Returns null for empty/unrecognized values → the map then shows
 * an initials avatar. Already-http(s) URLs pass through unchanged. */
function toStaticImageUrl(v) {
  if (!v || typeof v !== 'string') return null;
  if (/^https?:\/\//i.test(v)) return v;
  const m = v.match(/^wix:image:\/\/v1\/([^/]+)/i);
  return m ? `https://static.wixstatic.com/media/${m[1]}` : null;
}

/* Normalize a stops column to an array of number-strings (the CMS stores ARRAY_STRING). */
function stopArray(v) {
  if (Array.isArray(v)) return v.map(String);
  if (v == null || v === '') return [];
  return String(v).split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

function toProvider(m) {
  return {
    id: m._id,
    name: m[FIELDS.name] || '',
    org: m[FIELDS.org] || '',
    type: 'coach', // Team collection = coaches/EIRs. (Add a Resources branch as type:'tap' later.)
    photo: toStaticImageUrl(m[FIELDS.photo]),
    bio: m[FIELDS.bio] || '',
    website: m[FIELDS.linkedIn] || m[FIELDS.website] || '',
    services: Array.isArray(m[FIELDS.serviceAreas]) ? m[FIELDS.serviceAreas] : [],
    stops: {
      MRL: stopArray(m[FIELDS.mrl]),
      TRL: stopArray(m[FIELDS.trl]),
      CRL: stopArray(m[FIELDS.crl]),
      IRL: stopArray(m[FIELDS.irl]),
    },
  };
}

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  // Wix "Embed HTML" elements run in a sandboxed iframe on a DIFFERENT origin than the site,
  // so the map's fetch is cross-origin — allow it:
  'Access-Control-Allow-Origin': '*',
};

export async function get_providers(request) {
  try {
    // Page through the collection (query caps at 1000/req; 200 is plenty for the coach bench).
    const res = await wixData
      .query(COLLECTION)
      .hasSome(FIELDS.tags, ['EIR', 'Team']) // coaches only; excludes Board-only
      .limit(200)
      .find({ suppressAuth: true });

    const providers = res.items
      .map(toProvider)
      // Only show people who have been placed on at least one line (tagged), so untagged rows
      // don't render as empty cards while the backfill is still running.
      .filter((p) => p.stops.MRL.length || p.stops.TRL.length || p.stops.CRL.length || p.stops.IRL.length);

    return ok({ headers: JSON_HEADERS, body: { providers } });
  } catch (e) {
    return serverError({ headers: JSON_HEADERS, body: { error: String((e && e.message) || e), providers: [] } });
  }
}
