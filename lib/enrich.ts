// lib/enrich.ts — Address enrichment logic (Census Geocoder + local MI zone polygons)

import type { EnrichmentResult } from '@/types';
import { classifyMiZones } from './enrichment/data/miGeoZones';

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
    // Local point-in-polygon against the MI HUBZone + Opportunity Zone layers (no network).
    const { hubzone, opportunityZone } = classifyMiZones(lat, lng);
    const geoDisadvantaged = hubzone || opportunityZone;
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

/** fetch with an abort timeout so a hung geocoder call can't stall a batch worker. */
async function fetchWithTimeout(url: string, ms = 12000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
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

    const res = await fetchWithTimeout(
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

    const res = await fetchWithTimeout(
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

