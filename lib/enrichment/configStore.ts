// lib/enrichment/configStore.ts — Postgres-backed store for enricher gate configs.
//
// Mirrors WixMappingStore (lib/mapping/wixStore.ts): id/name-aware CRUD over the enricher_configs
// table + a short TTL cache. The engine never reads the table directly — it calls
// resolveEnricherConfig(name, sourceObject), which returns the stored row when present and otherwise
// the CODE DEFAULT (today's hardcoded behavior). So a missing row / missing DB changes nothing, and a
// row edited in /enrichment changes what the next run does.

import { and, asc, eq } from 'drizzle-orm';
import { getDb, hasDatabase } from '../db';
import { enricherConfigs, type EnricherConfigRow } from '../db/schema';
import type { EnricherConfig, EnricherConfigInput, EnricherMembership, EnricherStatusGate } from './configTypes';

const TTL_MS = 5 * 60 * 1000;

/**
 * Code defaults = the behavior before this table existed, keyed by "<enricher>::<sourceObject>".
 * The readiness tagger's gate is pinned here so cutover is a no-op even if the row is never seeded:
 * status runOn ['Approved'] (credit gate) + membership Team/EIR (coaches only, Board excluded).
 */
export const DEFAULT_ENRICHER_CONFIGS: Record<string, EnricherConfig> = {
  'readiness-tagger::contact': {
    enricher: 'readiness-tagger',
    sourceObject: 'contact',
    enabled: true,
    gate: { field: 'contact.status', runOn: ['Approved'] },
    membership: { field: 'contact.website_team_tags', anyOf: ['Team', 'EIR'] },
  },
};

const keyOf = (enricher: string, sourceObject: string) => `${enricher}::${sourceObject}`;

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

/** Validate a status gate payload. `null`/empty field => null (no status restriction). */
export function sanitizeStatusGate(raw: any): EnricherStatusGate | null {
  if (raw == null) return null;
  if (typeof raw !== 'object') throw new Error('gate must be an object or null');
  const field = typeof raw.field === 'string' ? raw.field.trim() : '';
  if (!field) return null;
  return { field, runOn: strArray(raw.runOn) };
}

/** Validate a membership gate payload. `null`/empty field => null (no membership restriction). */
export function sanitizeMembership(raw: any): EnricherMembership | null {
  if (raw == null) return null;
  if (typeof raw !== 'object') throw new Error('membership must be an object or null');
  const field = typeof raw.field === 'string' ? raw.field.trim() : '';
  if (!field) return null;
  return { field, anyOf: strArray(raw.anyOf) };
}

/** Build a clean EnricherConfigInput from an API body for a known (enricher, sourceObject). */
export function sanitizeEnricherConfigInput(body: any, enricher: string, sourceObject: string): EnricherConfigInput {
  return {
    enricher,
    sourceObject,
    enabled: body?.enabled !== false,
    gate: sanitizeStatusGate(body?.gate),
    membership: sanitizeMembership(body?.membership),
  };
}

/** Pure: the code default for an enricher, or a permissive "always run" config when none is defined. */
export function defaultEnricherConfig(enricher: string, sourceObject = 'contact'): EnricherConfig {
  return (
    DEFAULT_ENRICHER_CONFIGS[keyOf(enricher, sourceObject)] ?? {
      enricher,
      sourceObject,
      enabled: true,
      gate: null,
      membership: null,
    }
  );
}

/** Pure: map a DB row (or null) to the resolved config, falling back to the code default. */
export function configFromRow(row: EnricherConfigRow | null | undefined, enricher: string, sourceObject = 'contact'): EnricherConfig {
  if (!row) return defaultEnricherConfig(enricher, sourceObject);
  return {
    enricher: row.enricher,
    sourceObject: row.sourceObject,
    enabled: row.enabled,
    gate: (row.gate as EnricherStatusGate | null) ?? null,
    membership: (row.membership as EnricherMembership | null) ?? null,
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

  /** Insert or replace the config for (enricher, sourceObject); bumps version. */
  async upsert(input: EnricherConfigInput): Promise<EnricherConfig> {
    const db = getDb();
    const now = new Date();
    await db
      .insert(enricherConfigs)
      .values({
        enricher: input.enricher,
        sourceObject: input.sourceObject,
        enabled: input.enabled,
        gate: input.gate ?? null,
        membership: input.membership ?? null,
        version: 1,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [enricherConfigs.enricher, enricherConfigs.sourceObject],
        set: {
          enabled: input.enabled,
          gate: input.gate ?? null,
          membership: input.membership ?? null,
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
