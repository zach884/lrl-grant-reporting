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
    const geoDisadvantaged = await queryArcGIS(lat, lng);
    return { county, geoDisadvantaged };
  }

  // Fallback: look up county by zip code
  const county = await countyFromZip(postalCode);
  return { county, geoDisadvantaged: null };
}

/** Look up county using Nominatim (OpenStreetMap) geocoder + FCC Area API */
async function countyFromZip(zip: string): Promise<string | null> {
  if (!zip) return null;
  const cleanZip = zip.replace(/\s+/g, '').trim().slice(0, 5);
  try {
    const nomRes = await fetch(
      `https://nominatim.openstreetmap.org/search?postalcode=${cleanZip}&country=US&format=json&limit=1`,
      { headers: { 'User-Agent': 'LRL-Activity-Tracker/1.0' } }
    );
    if (!nomRes.ok) return null;

    const nomData = await nomRes.json();
    if (!nomData[0]?.lat || !nomData[0]?.lon) return null;

    const fccRes = await fetch(
      `https://geo.fcc.gov/api/census/area?lat=${nomData[0].lat}&lon=${nomData[0].lon}&format=json`
    );
    if (!fccRes.ok) return null;

    const fccData = await fccRes.json();
    return fccData?.results?.[0]?.county_name ?? null;
  } catch {
    return null;
  }
}

async function geocodeCensus(
  street: string,
  city: string,
  state: string,
  zip: string
): Promise<GeocodeResult | null> {
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

  // Attempt 2: One-line address format
  const onelineResult = await censusGeocodeOneline(
    `${cleanStreet}, ${cleanCity}, ${cleanState} ${cleanZip}`
  );
  if (onelineResult) return onelineResult;

  // Attempt 3: City/state/zip only
  const cityResult = await censusGeocodeOneline(
    `${cleanCity}, ${cleanState} ${cleanZip}`
  );
  if (cityResult) return cityResult;

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
    return extractGeocodeResult(data?.result?.addressMatches?.[0]);
  } catch {
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
    return extractGeocodeResult(data?.result?.addressMatches?.[0]);
  } catch {
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

// Cache for ArcGIS layer URLs discovered from the webmap
let arcgisLayerUrls: string[] | null = null;

async function getArcGISLayerUrls(): Promise<string[]> {
  if (arcgisLayerUrls && arcgisLayerUrls.length > 0) return arcgisLayerUrls;

  try {
    const res = await fetch(
      'https://www.arcgis.com/sharing/rest/content/items/d2f96fbb11cc49169de85cb577278e4b/data?f=json'
    );
    if (!res.ok) throw new Error(`ArcGIS webmap fetch failed: ${res.status}`);

    const data = await res.json();
    const urls: string[] = [];

    const extractUrls = (layers: any[]) => {
      for (const layer of layers) {
        if (layer.url) urls.push(layer.url);
        if (layer.layers) extractUrls(layer.layers);
        if (layer.featureCollection?.layers) {
          for (const fcLayer of layer.featureCollection.layers) {
            if (fcLayer.layerDefinition?.url) urls.push(fcLayer.layerDefinition.url);
          }
        }
      }
    };

    if (data.operationalLayers) extractUrls(data.operationalLayers);
    if (data.tables) extractUrls(data.tables);

    if (urls.length > 0) {
      arcgisLayerUrls = urls;
      return urls;
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback: well-known HUBZone and Opportunity Zone services
  arcgisLayerUrls = [
    'https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/HUBZones_Redesignated_Areas/FeatureServer/0',
    'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Opportunity_Zones/FeatureServer/0',
  ];
  return arcgisLayerUrls;
}

async function queryArcGIS(lat: number, lng: number): Promise<boolean | null> {
  try {
    const layerUrls = await getArcGISLayerUrls();
    if (layerUrls.length === 0) return null;

    for (const layerUrl of layerUrls) {
      try {
        const params = new URLSearchParams({
          geometry: `${lng},${lat}`,
          geometryType: 'esriGeometryPoint',
          inSR: '4326',
          spatialRel: 'esriSpatialRelIntersects',
          returnCountOnly: 'true',
          f: 'json',
        });

        const res = await fetch(`${layerUrl}/query?${params}`);
        if (!res.ok) continue;

        const data = await res.json();
        if (data.count > 0) return true;
      } catch {
        continue;
      }
    }

    return false;
  } catch {
    return null;
  }
}
