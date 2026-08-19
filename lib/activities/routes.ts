// lib/activities/routes.ts — "which source thing produces which activity type", as config.
//
// Zach expects to create NEW calendars and calendar groups rather than repoint the existing ones
// (the current reporting workflow is fragile). So routing is data, never code: adding a calendar is
// a row, not a deploy — the same config-as-data property the mapping engine and enricher gates have.
//
// THE DEFAULT IS TO DO NOTHING. A calendar with no rule produces no activity. That is not laziness:
// five of the fourteen live calendars are personal links used for vendor and partner calls, and
// inventing activities for those would corrupt the reports this exists to feed. Silence is the safe
// failure; a fabricated activity is not.
//
// A rule can also stamp `program__grant_association`. Read that as ORIGIN ("this meeting was booked
// on the SAMA calendar"), which is a fact — NOT as grant eligibility, which is a lens and belongs to
// the report engine. Eligibility depends on company firmographics that often arrive AFTER the
// meeting (SBSH's CDFI-tract / QCT / rural rules come from the geo enricher), so a tag frozen at
// ingestion can be computed before its own inputs exist. See docs/sprints/report-engine-design.md.

import { and, eq } from 'drizzle-orm';
import { getDb, hasDatabase } from '../db';
import { activityRoutes, type ActivityRouteRow } from '../db/schema';

export type RouteMatchKind = 'calendar' | 'calendar_group' | 'form' | 'pipeline_stage';

export interface ActivityRoute {
  source: string;
  matchKind: RouteMatchKind;
  matchId: string;
  matchLabel?: string;
  activityType: string;
  program?: string[];
  defaults?: Record<string, unknown>;
  enabled: boolean;
}

const TTL_MS = 10 * 60 * 1000;
let cache: { at: number; rows: ActivityRoute[] } | null = null;

const toRoute = (r: ActivityRouteRow): ActivityRoute => ({
  source: r.source,
  matchKind: r.matchKind as RouteMatchKind,
  matchId: r.matchId,
  matchLabel: r.matchLabel ?? undefined,
  activityType: r.activityType,
  program: r.program ?? undefined,
  defaults: r.defaults ?? undefined,
  enabled: r.enabled,
});

/** Every routing rule. Cached for 10 minutes, like the field catalogs and mapping sets. */
export async function listRoutes(opts: { force?: boolean } = {}): Promise<ActivityRoute[]> {
  if (!hasDatabase) return [];
  if (!opts.force && cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const rows = await getDb().select().from(activityRoutes);
  const routes = rows.map(toRoute);
  cache = { at: Date.now(), rows: routes };
  return routes;
}

export function clearRouteCache(): void {
  cache = null;
}

/**
 * The rule for a source thing, or null when there is none (→ ingest nothing).
 *
 * `candidates` are tried in order, so a per-calendar rule beats its group's rule: pass
 * `[{kind:'calendar', id}, {kind:'calendar_group', id}]` to get "specific overrides general".
 */
export async function resolveRoute(
  source: string,
  candidates: Array<{ kind: RouteMatchKind; id: string | undefined | null }>,
): Promise<ActivityRoute | null> {
  const routes = await listRoutes();
  for (const c of candidates) {
    if (!c.id) continue;
    const hit = routes.find((r) => r.source === source && r.matchKind === c.kind && r.matchId === c.id);
    if (hit) return hit.enabled ? hit : null;
  }
  return null;
}

/** Create or update one rule (idempotent on source + matchKind + matchId). */
export async function upsertRoute(route: ActivityRoute): Promise<void> {
  if (!hasDatabase) throw new Error('No database configured — activity routes need Postgres');
  await getDb()
    .insert(activityRoutes)
    .values({
      source: route.source,
      matchKind: route.matchKind,
      matchId: route.matchId,
      matchLabel: route.matchLabel ?? null,
      activityType: route.activityType,
      program: route.program ?? null,
      defaults: route.defaults ?? null,
      enabled: route.enabled,
    })
    .onConflictDoUpdate({
      target: [activityRoutes.source, activityRoutes.matchKind, activityRoutes.matchId],
      set: {
        matchLabel: route.matchLabel ?? null,
        activityType: route.activityType,
        program: route.program ?? null,
        defaults: route.defaults ?? null,
        enabled: route.enabled,
      },
    });
  clearRouteCache();
}

export async function deleteRoute(source: string, matchKind: RouteMatchKind, matchId: string): Promise<void> {
  if (!hasDatabase) return;
  await getDb()
    .delete(activityRoutes)
    .where(and(eq(activityRoutes.source, source), eq(activityRoutes.matchKind, matchKind), eq(activityRoutes.matchId, matchId)));
  clearRouteCache();
}
