// lib/enrichment/stateStore.ts — per-company enricher STATE (Postgres-backed, best-effort).
//
// Powers state-based gating for the real-time enrichers: instead of asking "did the app's up-sync
// write a diff this run" (empty when GHL native sync populated the company first), each enricher asks
// "is my output missing/stale for THIS company." The scorer stores a fingerprint of the inputs it last
// scored (recompute only on a real change); county/geo store the address they last geocoded (re-run only
// on a real address change). All reads/writes fail soft — no DB or a query error degrades to "no state"
// (=> run), never throwing into the webhook's critical path.

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, hasDatabase } from '../db';
import { enricherState } from '../db/schema';

export interface EnricherState {
  companyId: string;
  scoreInputHash: string | null;
  geocodedAddress: string | null;
}

/** Stable fingerprint of a string (the scoring-input blob). */
export function fingerprint(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** Normalize a company's address fields into a comparable string (empty when no address present). */
export function normalizeCompanyAddress(get: (key: string) => unknown): string {
  const parts = ['business.address', 'business.city', 'business.state', 'business.postalcode'].map(
    (k) => String(get(k) ?? '').trim().toLowerCase(),
  );
  return parts.some((p) => p) ? parts.join('|') : '';
}

/** True when county/geo should (re)run: there's an address AND it differs from what we last geocoded. */
export function addressNeedsGeocode(currentAddress: string, storedAddress: string | null | undefined): boolean {
  if (!currentAddress) return false; // nothing to geocode
  return storedAddress == null || storedAddress !== currentAddress;
}

export async function getEnricherState(companyId: string): Promise<EnricherState | null> {
  if (!hasDatabase) return null;
  try {
    const row = await getDb().query.enricherState.findFirst({ where: eq(enricherState.companyId, companyId) });
    return row
      ? { companyId, scoreInputHash: row.scoreInputHash ?? null, geocodedAddress: row.geocodedAddress ?? null }
      : null;
  } catch {
    return null;
  }
}

/** Upsert the given fields for a company (only the provided keys are changed). Best-effort. */
export async function setEnricherState(
  companyId: string,
  patch: { scoreInputHash?: string; geocodedAddress?: string },
): Promise<void> {
  if (!hasDatabase || Object.keys(patch).length === 0) return;
  try {
    const now = new Date();
    await getDb()
      .insert(enricherState)
      .values({ companyId, scoreInputHash: patch.scoreInputHash ?? null, geocodedAddress: patch.geocodedAddress ?? null, updatedAt: now })
      .onConflictDoUpdate({ target: enricherState.companyId, set: { ...patch, updatedAt: now } });
  } catch {
    /* best-effort — a state write failure must never break enrichment */
  }
}
