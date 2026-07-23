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

/* Resources (Technical Assistance Providers) collection = `Import1`. Same readiness columns as Team
 * (serviceAreas + the 4 stop arrays, written by the resource-tagger + synced GHL → Wix). No membership
 * tags — every resource is a TA provider. Mapped to type:'tap' (the map renders a separate TA group). */
const RES_COLLECTION = 'Import1';
const RES_FIELDS = {
  name: 'companyResourceName',
  org: 'category',
  photo: 'logo',
  bio: 'shortDescription',
  website: 'website',
  serviceAreas: 'serviceAreas',
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
    type: 'coach', // Team collection = coaches/EIRs.
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

/* Resources collection row → provider (type:'tap'). Same shape; placement by the synced stops. */
function toTapProvider(m) {
  return {
    id: m._id,
    name: m[RES_FIELDS.name] || '',
    org: m[RES_FIELDS.org] || '',
    type: 'tap',
    photo: toStaticImageUrl(m[RES_FIELDS.photo]),
    bio: m[RES_FIELDS.bio] || '',
    website: m[RES_FIELDS.website] || '',
    services: Array.isArray(m[RES_FIELDS.serviceAreas]) ? m[RES_FIELDS.serviceAreas] : [],
    stops: {
      MRL: stopArray(m[RES_FIELDS.mrl]),
      TRL: stopArray(m[RES_FIELDS.trl]),
      CRL: stopArray(m[RES_FIELDS.crl]),
      IRL: stopArray(m[RES_FIELDS.irl]),
    },
  };
}

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  // Wix "Embed HTML" elements run in a sandboxed iframe on a DIFFERENT origin than the site,
  // so the map's fetch is cross-origin — allow it:
  'Access-Control-Allow-Origin': '*',
};

/** True when a provider is placed on at least one line (tagged) — hides untagged rows. */
function isPlaced(p) {
  return p.stops.MRL.length || p.stops.TRL.length || p.stops.CRL.length || p.stops.IRL.length;
}

export async function get_providers(request) {
  try {
    // Coaches (Team) — EIR/Team only, Board excluded.
    const teamRes = await wixData
      .query(COLLECTION)
      .hasSome(FIELDS.tags, ['EIR', 'Team'])
      .limit(200)
      .find({ suppressAuth: true });
    const coaches = teamRes.items.map(toProvider).filter(isPlaced);

    // Resources (TA providers) — every resource; placement by its synced stops.
    let taps = [];
    try {
      const resRes = await wixData.query(RES_COLLECTION).limit(200).find({ suppressAuth: true });
      taps = resRes.items.map(toTapProvider).filter(isPlaced);
    } catch (e) {
      // A missing/renamed Resources collection must not break the coach bench.
    }

    return ok({ headers: JSON_HEADERS, body: { providers: [...coaches, ...taps] } });
  } catch (e) {
    return serverError({ headers: JSON_HEADERS, body: { error: String((e && e.message) || e), providers: [] } });
  }
}
