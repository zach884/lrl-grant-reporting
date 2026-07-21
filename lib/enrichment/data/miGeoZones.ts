// lib/enrichment/data/miGeoZones.ts — LOCAL point-in-polygon classification for Michigan
// HUBZones + Opportunity Zones.
//
// Replaces the external ArcGIS feature-service queries (which broke: HUBZone URL went 400
// "Invalid URL" after SBA re-published, and Opportunity Zone went 499 "Token Required").
// The polygons are extracted from Zach's authoritative ArcGIS webmap
// (item d2f96fbb11cc49169de85cb577278e4b — "Michigan HUBZones" + "Michigan Opportunity Zones"),
// converted from EPSG:3857 to WGS84, with a per-polygon bbox precomputed for fast rejection.
// See scripts to rebuild in the repo history. Self-contained → no network dependency, so the
// enrichment can't silently break again when a hosted service changes.

import zones from './mi-geo-zones.json';

type Feature = { bbox: [number, number, number, number]; rings: number[][][] };
const HUBZONE = zones.hubzone as Feature[];
const OPP_ZONE = zones.opportunity_zone as Feature[];

/** Ray-casting point-in-polygon for one ring. lng=x, lat=y. */
function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = (yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** True if the point falls inside any polygon in the set (bbox-prefiltered). Each ArcGIS
 *  polygon's first ring is the outer boundary; we treat any ring hit as a member (these
 *  layers don't use holes for exclusion, so ring-parity within a feature is fine). */
function inAnyFeature(lng: number, lat: number, feats: Feature[]): boolean {
  for (const f of feats) {
    const [minLng, minLat, maxLng, maxLat] = f.bbox;
    if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) continue;
    for (const ring of f.rings) {
      if (pointInRing(lng, lat, ring)) return true;
    }
  }
  return false;
}

/** Classify a WGS84 point against the Michigan HUBZone + Opportunity Zone layers. */
export function classifyMiZones(lat: number, lng: number): { hubzone: boolean; opportunityZone: boolean } {
  return {
    hubzone: inAnyFeature(lng, lat, HUBZONE),
    opportunityZone: inAnyFeature(lng, lat, OPP_ZONE),
  };
}

export const MI_ZONE_COUNTS = { hubzone: HUBZONE.length, opportunityZone: OPP_ZONE.length };
