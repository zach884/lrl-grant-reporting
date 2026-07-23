// lib/enrichment/configStore.ts — Postgres-backed store for enricher gate configs (GROUPS model).
//
// Mirrors WixMappingStore (lib/mapping/wixStore.ts): id/name-aware CRUD over the enricher_configs
// table + a short TTL cache. The engine never reads the table directly — it calls
// resolveEnricherConfig(name, sourceObject), which returns the stored row when present and otherwise
// the CODE DEFAULT (today's behavior). A row's gate is GROUPS of filters combined with a top-level
// AND/OR. Rows written under older shapes are read back-compat: the flat `filters` column becomes one
// group; the legacy gate/membership columns become one ANDed group. So nothing needed re-migration.

import { and, asc, eq } from 'drizzle-orm';
import { getDb, hasDatabase } from '../db';
import { enricherConfigs, type EnricherConfigRow } from '../db/schema';
import type {
  EnricherConfig,
  EnricherConfigInput,
  EnricherFilter,
  EnricherGroup,
  EnricherMembership,
  EnricherStatusGate,
  FilterCombine,
} from './configTypes';

const TTL_MS = 5 * 60 * 1000;

/**
 * Code defaults = the behavior before this table existed, keyed by "<enricher>::<sourceObject>".
 * The readiness tagger's gate is pinned here so cutover is a no-op even if the row is never seeded:
 * status ∈ {Approved} AND website_team_tags ∋ {Team,EIR} (one group, ANDed).
 */
export const DEFAULT_ENRICHER_CONFIGS: Record<string, EnricherConfig> = {
  'readiness-tagger::contact': {
    enricher: 'readiness-tagger',
    sourceObject: 'contact',
    enabled: true,
    combine: 'AND',
    groups: [
      {
        combine: 'AND',
        filters: [
          { field: 'contact.status', anyOf: ['Approved'] },
          { field: 'contact.website_team_tags', anyOf: ['Team', 'EIR'] },
        ],
      },
    ],
  },
};

const keyOf = (enricher: string, sourceObject: string) => `${enricher}::${sourceObject}`;
const asCombine = (v: unknown): FilterCombine => (v === 'OR' ? 'OR' : 'AND');

/** Permissive default (always run) for an enricher with no code default and no row. */
export function defaultEnricherConfig(enricher: string, sourceObject = 'contact'): EnricherConfig {
  return (
    DEFAULT_ENRICHER_CONFIGS[keyOf(enricher, sourceObject)] ?? {
      enricher,
      sourceObject,
      enabled: true,
      groups: [],
      combine: 'AND',
    }
  );
}

function cleanFilters(raw: unknown): EnricherFilter[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((f: any) => ({ field: typeof f?.field === 'string' ? f.field.trim() : '', anyOf: Array.isArray(f?.anyOf) ? f.anyOf.map((v: any) => String(v).trim()).filter(Boolean) : [] }))
    .filter((f) => f.field);
}

function cleanGroups(raw: unknown): EnricherGroup[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((g: any) => ({ combine: asCombine(g?.combine), filters: cleanFilters(g?.filters) }))
    .filter((g) => g.filters.length > 0);
}

/** Fold the deprecated gate+membership columns into one ANDed group for a legacy row. */
function legacyGroup(row: EnricherConfigRow): EnricherGroup[] {
  const filters: EnricherFilter[] = [];
  const g = row.gate as EnricherStatusGate | null;
  if (g?.field && g.runOn?.length) filters.push({ field: g.field, anyOf: g.runOn });
  const m = row.membership as EnricherMembership | null;
  if (m?.field && m.anyOf?.length) filters.push({ field: m.field, anyOf: m.anyOf });
  return filters.length ? [{ combine: 'AND', filters }] : [];
}

/** Pure: map a DB row (or null) to the resolved config, preferring the groups column, then the flat
 *  filters column (wrapped as one group), then the legacy gate/membership columns, then the default. */
export function configFromRow(row: EnricherConfigRow | null | undefined, enricher: string, sourceObject = 'contact'): EnricherConfig {
  if (!row) return defaultEnricherConfig(enricher, sourceObject);

  let groups: EnricherGroup[];
  let combine: FilterCombine = asCombine(row.combine);
  if (Array.isArray(row.groups)) {
    groups = cleanGroups(row.groups);
  } else if (Array.isArray(row.filters)) {
    // Pre-groups row: the flat filter list becomes one group whose internal combine was `row.combine`.
    // The top-level combine is irrelevant with a single group, so pin it to AND.
    const filters = cleanFilters(row.filters);
    groups = filters.length ? [{ combine: asCombine(row.combine), filters }] : [];
    combine = 'AND';
  } else {
    groups = legacyGroup(row);
    combine = 'AND';
  }

  return { enricher: row.enricher, sourceObject: row.sourceObject, enabled: row.enabled, groups, combine };
}

/** Validate an API body into a clean EnricherConfigInput. Accepts `groups` (current) or a flat
 *  `filters` array (wrapped into one group) for convenience. */
export function sanitizeEnricherConfigInput(body: any, enricher: string, sourceObject: string): EnricherConfigInput {
  let groups: EnricherGroup[];
  if (Array.isArray(body?.groups)) groups = cleanGroups(body.groups);
  else {
    const filters = cleanFilters(body?.filters);
    groups = filters.length ? [{ combine: asCombine(body?.combine), filters }] : [];
  }
  return {
    enricher,
    sourceObject,
    enabled: body?.enabled !== false,
    groups,
    combine: asCombine(body?.combine),
  };
}

export class EnricherConfigStore {
  private cache = new Map<string, { config: EnricherConfig | null; at: number }>();

  async list(): Promise<EnricherConfig[]> {
    const db = getDb();
    const rows = await db.select().from(enricherConfigs).orderBy(asc(enricherConfigs.enricher));
    return rows.map((r) => configFromRow(r, r.enricher, r.sourceObject));
  }

  /** The stored row for one enricher, or null if none (caller falls back to the default). */
  async get(enricher: string, sourceObject = 'contact'): Promise<EnricherConfig | null> {
    const k = keyOf(enricher, sourceObject);
    const hit = this.cache.get(k);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.config;

    const db = getDb();
    const row = await db.query.enricherConfigs.findFirst({
      where: and(eq(enricherConfigs.enricher, enricher), eq(enricherConfigs.sourceObject, sourceObject)),
    });
    const config = row ? configFromRow(row, enricher, sourceObject) : null;
    this.cache.set(k, { config, at: Date.now() });
    return config;
  }

  /** Insert or replace the config for (enricher, sourceObject); writes the groups model and clears
   *  the deprecated filters/gate/membership columns so groups is the single source of truth. */
  async upsert(input: EnricherConfigInput): Promise<EnricherConfig> {
    const db = getDb();
    const now = new Date();
    const values = {
      enricher: input.enricher,
      sourceObject: input.sourceObject,
      enabled: input.enabled,
      groups: input.groups ?? [],
      combine: input.combine ?? 'AND',
      filters: null,
      gate: null,
      membership: null,
    };
    await db
      .insert(enricherConfigs)
      .values({ ...values, version: 1, updatedAt: now })
      .onConflictDoUpdate({
        target: [enricherConfigs.enricher, enricherConfigs.sourceObject],
        set: { ...values, updatedAt: now },
      });
    this.invalidate(input.enricher, input.sourceObject);
    return (await this.get(input.enricher, input.sourceObject))!;
  }

  invalidate(enricher?: string, sourceObject = 'contact'): void {
    if (enricher) this.cache.delete(keyOf(enricher, sourceObject));
    else this.cache.clear();
  }
}

let _store: EnricherConfigStore | null = null;
export function getEnricherConfigStore(): EnricherConfigStore {
  if (!hasDatabase) throw new Error('POSTGRES_URL is not set — enricher config store unavailable');
  if (!_store) _store = new EnricherConfigStore();
  return _store;
}

/**
 * The engine entry point: resolve an enricher's gate config. Returns the stored row when present,
 * else the code default. Never throws — if the DB is absent or the read fails, we fall back to the
 * code default so a run behaves exactly as it did before this table existed.
 */
export async function resolveEnricherConfig(enricher: string, sourceObject = 'contact'): Promise<EnricherConfig> {
  if (!hasDatabase) return defaultEnricherConfig(enricher, sourceObject);
  try {
    const stored = await getEnricherConfigStore().get(enricher, sourceObject);
    return stored ?? defaultEnricherConfig(enricher, sourceObject);
  } catch {
    return defaultEnricherConfig(enricher, sourceObject);
  }
}
