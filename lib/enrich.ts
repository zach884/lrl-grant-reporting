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

  if (!geocodeResult) {
    return { county: null, geoDisadvantaged: null };
  }

  const { lat, lng, county } = geocodeResult;
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
    // Clean up address for Census geocoder — remove periods, normalize abbreviations
    const cleanStreet = street.replace(/\./g, '').trim();
    const cleanCity = city.replace(/\./g, '').trim();
    // Normalize state — Census expects full name or 2-letter abbreviation without periods
    const cleanState = state.replace(/\./g, '').trim();
    const cleanZip = zip.replace(/\s+/g, '').trim();

    const params = new URLSearchParams({
      street: cleanStreet,
      city: cleanCity,
      state: cleanState,
      zip: cleanZip,
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
    console.log('Census geocoder response:', JSON.stringify(data?.result?.addressMatches?.length ?? 0), 'matches for', street, city, state, zip);
    const match = data?.result?.addressMatches?.[0];

    if (!match) {
      console.warn('Census geocoder: no address match for', street, city, state, zip);
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

    // Walk through all operational layers and sublayers to find feature service URLs
    const extractUrls = (layers: any[]) => {
      for (const layer of layers) {
        if (layer.url) {
          urls.push(layer.url);
        }
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

    console.log('ArcGIS layer URLs discovered:', urls);

    if (urls.length > 0) {
      arcgisLayerUrls = urls;
      return urls;
    }
  } catch (err) {
    console.warn('Failed to fetch ArcGIS webmap data:', err);
  }

  // Fallback: use well-known HUBZone and Opportunity Zone services
  console.log('Using fallback ArcGIS layer URLs');
  arcgisLayerUrls = [
    // HUBZone qualified areas (SBA)
    'https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/HUBZones_Redesignated_Areas/FeatureServer/0',
    // Opportunity Zones
    'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Opportunity_Zones/FeatureServer/0',
  ];
  return arcgisLayerUrls;
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
        if (!res.ok) {
          console.warn(`ArcGIS query to ${layerUrl} returned ${res.status}`);
          continue;
        }

        const data = await res.json();
        if (data.count > 0) return true;
      } catch (err) {
        console.warn(`ArcGIS query failed for ${layerUrl}:`, err);
        continue;
      }
    }

    return false;
  } catch (err) {
    console.error('ArcGIS query error:', err);
    return null;
  }
}
