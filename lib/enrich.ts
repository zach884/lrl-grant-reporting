// lib/enrich.ts — Address enrichment logic (Census Geocoder + ArcGIS)

import type { EnrichmentResult } from '@/types';

interface GeocodeResult {
  lat: number;
  lng: number;
  county: string;
}

export async function enrichAddress(
  address1: string,
  city: string,
  state: string,
  postalCode: string
): Promise<EnrichmentResult> {
  const geocodeResult = await geocodeCensus(address1, city, state, postalCode);

  if (geocodeResult) {
    const { lat, lng, county } = geocodeResult;
    const { hubzone, opportunityZone } = await queryArcGIS(lat, lng);
    const geoDisadvantaged =
      hubzone == null && opportunityZone == null ? null : Boolean(hubzone) || Boolean(opportunityZone);
    return { county, geoDisadvantaged, hubzone, opportunityZone };
  }

  // Fallback: look up county by zip code (no lat/lng → can't determine zones)
  const county = await countyFromZip(postalCode);
  if (county) {
    console.log(`Zip fallback: ${postalCode} → ${county}`);
  }
  return { county, geoDisadvantaged: null, hubzone: null, opportunityZone: null };
}

/** Look up county using Nominatim (OpenStreetMap) geocoder + FCC Area API */
async function countyFromZip(zip: string): Promise<string | null> {
  if (!zip) return null;
  const cleanZip = zip.replace(/\s+/g, '').trim().slice(0, 5);
  try {
    // Step 1: Get lat/lng from zip via Nominatim
    const nomRes = await fetch(
      `https://nominatim.openstreetmap.org/search?postalcode=${cleanZip}&country=US&format=json&limit=1`,
      { headers: { 'User-Agent': 'LRL-Activity-Tracker/1.0' } }
    );
    if (!nomRes.ok) return null;

    const nomData = await nomRes.json();
    if (!nomData[0]?.lat || !nomData[0]?.lon) return null;

    const lat = nomData[0].lat;
    const lng = nomData[0].lon;

    // Step 2: Get county from lat/lng via FCC Area API (free, no key)
    const fccRes = await fetch(
      `https://geo.fcc.gov/api/census/area?lat=${lat}&lon=${lng}&format=json`
    );
    if (!fccRes.ok) return null;

    const fccData = await fccRes.json();
    const county = fccData?.results?.[0]?.county_name ?? null;
    return county;
  } catch (err) {
    console.warn('County from zip fallback error:', err);
    return null;
  }
}

async function geocodeCensus(
  street: string,
  city: string,
  state: string,
  zip: string
): Promise<GeocodeResult | null> {
  // Clean up address data
  const cleanStreet = street.replace(/\./g, '').trim();
  const cleanCity = city.replace(/\./g, '').trim();
  const cleanState = state.replace(/\./g, '').trim().toUpperCase();
  const cleanZip = zip.replace(/\s+/g, '').trim();

  // Attempt 1: Structured address fields
  const result = await censusGeocode({
    street: cleanStreet,
    city: cleanCity,
    state: cleanState,
    zip: cleanZip,
  });
  if (result) return result;

  // Attempt 2: One-line address format (sometimes matches better)
  const onelineResult = await censusGeocodeOneline(
    `${cleanStreet}, ${cleanCity}, ${cleanState} ${cleanZip}`
  );
  if (onelineResult) return onelineResult;

  // Attempt 3: Without street number variations — try just city/state/zip
  // This won't give us lat/lng but can give us county
  const cityResult = await censusGeocodeOneline(
    `${cleanCity}, ${cleanState} ${cleanZip}`
  );
  if (cityResult) {
    console.log('Census geocoder: matched on city/state/zip only (no street-level precision)');
    return cityResult;
  }

  console.warn('Census geocoder: all attempts failed for', cleanStreet, cleanCity, cleanState, cleanZip);
  return null;
}

async function censusGeocode(params: {
  street: string;
  city: string;
  state: string;
  zip: string;
}): Promise<GeocodeResult | null> {
  try {
    const urlParams = new URLSearchParams({
      ...params,
      benchmark: 'Public_AR_Current',
      vintage: 'Current_Current',
      layers: 'Counties',
      format: 'json',
    });

    const res = await fetch(
      `https://geocoding.geo.census.gov/geocoder/geographies/address?${urlParams}`
    );
    if (!res.ok) return null;

    const data = await res.json();
    const matches = data?.result?.addressMatches ?? [];
    console.log(`Census structured: ${matches.length} matches for "${params.street}, ${params.city}, ${params.state} ${params.zip}"`);

    return extractGeocodeResult(matches[0]);
  } catch (err) {
    console.warn('Census structured geocode error:', err);
    return null;
  }
}

async function censusGeocodeOneline(address: string): Promise<GeocodeResult | null> {
  try {
    const params = new URLSearchParams({
      onelineaddress: address,
      benchmark: 'Public_AR_Current',
      vintage: 'Current_Current',
      layers: 'Counties',
      format: 'json',
    });

    const res = await fetch(
      `https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?${params}`
    );
    if (!res.ok) return null;

    const data = await res.json();
    const matches = data?.result?.addressMatches ?? [];
    console.log(`Census oneline: ${matches.length} matches for "${address}"`);

    return extractGeocodeResult(matches[0]);
  } catch (err) {
    console.warn('Census oneline geocode error:', err);
    return null;
  }
}

function extractGeocodeResult(match: any): GeocodeResult | null {
  if (!match) return null;

  const lat = match.coordinates?.y;
  const lng = match.coordinates?.x;
  const county = match.geographies?.Counties?.[0]?.NAME ?? null;

  if (lat == null || lng == null) return null;

  return { lat, lng, county };
}

// Typed zone layers so we can report WHICH zone(s) a point falls in (not just a combined
// boolean). Keyed by zone so the geo-zone enricher can emit HUBZone / Opportunity Zone /
// both / N/A. These are the canonical SBA HUBZone + Opportunity Zone feature services.
const ZONE_LAYERS: Array<{ key: 'hubzone' | 'opportunityZone'; url: string }> = [
  { key: 'hubzone', url: 'https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/HUBZones_Redesignated_Areas/FeatureServer/0' },
  { key: 'opportunityZone', url: 'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Opportunity_Zones/FeatureServer/0' },
];

/** Point-in-polygon per zone. Each flag is true/false, or null if that layer query failed. */
async function queryArcGIS(
  lat: number,
  lng: number,
): Promise<{ hubzone: boolean | null; opportunityZone: boolean | null }> {
  const out: { hubzone: boolean | null; opportunityZone: boolean | null } = {
    hubzone: null,
    opportunityZone: null,
  };
  for (const layer of ZONE_LAYERS) {
    try {
      const params = new URLSearchParams({
        geometry: `${lng},${lat}`,
        geometryType: 'esriGeometryPoint',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        returnCountOnly: 'true',
        f: 'json',
      });
      const res = await fetch(`${layer.url}/query?${params}`);
      if (!res.ok) {
        console.warn(`ArcGIS ${layer.key} query returned ${res.status}`);
        continue; // leave null (unknown for this layer)
      }
      const data = await res.json();
      out[layer.key] = Number(data.count) > 0;
    } catch (err) {
      console.warn(`ArcGIS ${layer.key} query failed:`, err);
    }
  }
  return out;
}
