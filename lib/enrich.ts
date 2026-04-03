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
  // Step 1: Geocode via Census API
  const geocodeResult = await geocodeCensus(address1, city, state, postalCode);

  if (!geocodeResult) {
    return { county: null, geoDisadvantaged: null };
  }

  const { lat, lng, county } = geocodeResult;

  // Step 2: Point-in-polygon via ArcGIS
  const geoDisadvantaged = await queryArcGIS(lat, lng);

  return { county, geoDisadvantaged };
}

async function geocodeCensus(
  street: string,
  city: string,
  state: string,
  zip: string
): Promise<GeocodeResult | null> {
  try {
    const params = new URLSearchParams({
      street,
      city,
      state,
      zip,
      benchmark: 'Public_AR_Current',
      vintage: 'Current_Current',
      layers: 'Counties',
      format: 'json',
    });

    const res = await fetch(
      `https://geocoding.geo.census.gov/geocoder/geographies/address?${params}`
    );

    if (!res.ok) {
      console.warn('Census geocoder returned', res.status);
      return null;
    }

    const data = await res.json();
    const match = data?.result?.addressMatches?.[0];

    if (!match) {
      console.warn('Census geocoder: no address match');
      return null;
    }

    const lat = match.coordinates?.y;
    const lng = match.coordinates?.x;
    const county = match.geographies?.Counties?.[0]?.NAME ?? null;

    if (lat == null || lng == null) return null;

    return { lat, lng, county };
  } catch (err) {
    console.error('Census geocoder error:', err);
    return null;
  }
}

// ArcGIS feature layer URLs — extracted from the webmap
// These query Michigan Opportunity Zones and HUBZones
const ARCGIS_LAYER_URLS: string[] = [];

async function getArcGISLayerUrls(): Promise<string[]> {
  if (ARCGIS_LAYER_URLS.length > 0) return ARCGIS_LAYER_URLS;

  try {
    const res = await fetch(
      'https://www.arcgis.com/sharing/rest/content/items/d2f96fbb11cc49169de85cb577278e4b/data?f=json'
    );
    if (!res.ok) return [];

    const data = await res.json();
    const layers = data?.operationalLayers ?? [];

    for (const layer of layers) {
      if (layer.url) {
        ARCGIS_LAYER_URLS.push(layer.url);
      }
      // Check sublayers
      if (layer.layers) {
        for (const sub of layer.layers) {
          if (sub.url) ARCGIS_LAYER_URLS.push(sub.url);
        }
      }
    }

    return ARCGIS_LAYER_URLS;
  } catch (err) {
    console.error('Failed to fetch ArcGIS layer URLs:', err);
    return [];
  }
}

async function queryArcGIS(lat: number, lng: number): Promise<boolean | null> {
  try {
    const layerUrls = await getArcGISLayerUrls();

    if (layerUrls.length === 0) {
      console.warn('No ArcGIS layer URLs available');
      return null;
    }

    // Query each layer — if any returns count > 0, the point is in a disadvantaged area
    for (const layerUrl of layerUrls) {
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
    }

    return false;
  } catch (err) {
    console.error('ArcGIS query error:', err);
    return null;
  }
}
