// lib/enrichment/configStore.ts — Postgres-backed store for enricher gate configs (FILTERS model).
//
// Mirrors WixMappingStore (lib/mapping/wixStore.ts): id/name-aware CRUD over the enricher_configs
// table + a short TTL cache. The engine never reads the table directly — it calls
// resolveEnricherConfig(name, sourceObject), which returns the stored row when present and otherwise
// the CODE DEFAULT (today's behavior). A row's gate is a list of FILTERS ({field, anyOf[]}) combined
// with AND/OR. Rows written before the filters model are read back-compat from the legacy
// gate/membership columns, so nothing had to be re-migrated for correctness.

import { and, asc, eq } from 'drizzle-orm';
import { getDb, hasDatabase } from '../db';
import { enricherConfigs, type EnricherConfigRow } from '../db/schema';
import type {
  EnricherConfig,
  EnricherConfigInput,
  EnricherFilter,
  EnricherMembership,
  EnricherStatusGate,
  FilterCombine,
} from './configTypes';

const TTL_MS = 5 * 60 * 1000;

/**
 * Code defaults = the behavior before this table existed, keyed by "<enricher>::<sourceObject>".
 * The readiness tagger's gate is pinned here so cutover is a no-op even if the row is never seeded:
 * status ∈ {Approved} (credit gate) AND website_team_tags ∋ {Team,EIR} (coaches only, Board excluded).
 */
export const DEFAULT_ENRICHER_CONFIGS: Record<string, EnricherConfig> = {
  'readiness-tagger::contact': {
    enricher: 'readiness-tagger',
    sourceObject: 'contact',
    enabled: true,
    filters: [
      { field: 'contact.status', anyOf: ['Approved'] },
      { field: 'contact.website_team_tags', anyOf: ['Team', 'EIR'] },
    ],
    combine: 'AND',
  },
};

const keyOf = (enricher: string, sourceObject: string) => `${enricher}::${sourceObject}`;

/** Pure: the code default for an enricher, or a permissive "always run" config when none is defined. */
export function defaultEnricherConfig(enricher: string, sourceObject = 'contact'): EnricherConfig {
  return (
    DEFAULT_ENRICHER_CONFIGS[keyOf(enricher, sourceObject)] ?? {
      enricher,
      sourceObject,
      enabled: true,
      filters: [],
      combine: 'AND',
    }
  );
}

const cleanFilters = (raw: unknown): EnricherFilter[] =>
  Array.isArray(raw)
    ? raw
        .map((f: any) => ({ field: typeof f?.field === 'string' ? f.field.trim() : '', anyOf: Array.isArray(f?.anyOf) ? f.anyOf.map((v: any) => String(v).trim()).filter(Boolean) : [] }))
        .filter((f) => f.field)
    : [];

/** Fold the deprecated gate+membership columns into filters (both ANDed) for a legacy row. */
function legacyFilters(row: EnricherConfigRow): EnricherFilter[] {
  const out: EnricherFilter[] = [];
  const g = row.gate as EnricherStatusGate | null;
  if (g?.field && g.runOn?.length) out.push({ field: g.field, anyOf: g.runOn });
  const m = row.membership as EnricherMembership | null;
  if (m?.field && m.anyOf?.length) out.push({ field: m.field, anyOf: m.anyOf });
  return out;
}

/** Pure: map a DB row (or null) to the resolved config, preferring the filters column, then the
 *  legacy gate/membership columns, then the code default. */
export function configFromRow(row: EnricherConfigRow | null | undefined, enricher: string, sourceObject = 'contact'): EnricherConfig {
  if (!row) return defaultEnricherConfig(enricher, sourceObject);
  const hasFilters = Array.isArray(row.filters);
  const filters = hasFilters ? cleanFilters(row.filters) : legacyFilters(row);
  return {
    enricher: row.enricher,
    sourceObject: row.sourceObject,
    enabled: row.enabled,
    filters,
    combine: (row.combine as FilterCombine) === 'OR' ? 'OR' : 'AND',
  };
}

/** Validate an API body into a clean EnricherConfigInput for a known (enricher, sourceObject). */
export function sanitizeEnricherConfigInput(body: any, enricher: string, sourceObject: string): EnricherConfigInput {
  return {
    enricher,
    sourceObject,
    enabled: body?.enabled !== false,
    filters: cleanFilters(body?.filters),
    combine: body?.combine === 'OR' ? 'OR' : 'AND',
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

  /** Insert or replace the config for (enricher, sourceObject); writes the filters model and clears
   *  the deprecated gate/membership columns so filters is the single source of truth going forward. */
  async upsert(input: EnricherConfigInput): Promise<EnricherConfig> {
    const db = getDb();
    const now = new Date();
    await db
      .insert(enricherConfigs)
      .values({
        enricher: input.enricher,
        sourceObject: input.sourceObject,
        enabled: input.enabled,
        filters: input.filters ?? [],
        combine: input.combine ?? 'AND',
        gate: null,
        membership: null,
        version: 1,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [enricherConfigs.enricher, enricherConfigs.sourceObject],
        set: {
          enabled: input.enabled,
          filters: input.filters ?? [],
          combine: input.combine ?? 'AND',
          gate: null,
          membership: null,
          updatedAt: now,
        },
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
