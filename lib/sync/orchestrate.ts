// lib/sync/orchestrate.ts — real-time + batch orchestration on the generic push-connection model.
//
// This is the cutover target for the built-in contact↔company engine (lib/sync/{up,down}sync.ts +
// reconcile.ts). It drives the SAME two directions through the object-agnostic engine (apply.ts),
// reading the connection definitions from the DB (the `contact-to-company` + `company-to-contacts`
// push connections). Loop-safety is inherited from the engine's equality guard: writes fire only on
// real diffs, so a re-triggered webhook converges to a no-op. Selected via SYNC_ENGINE_MODE=generic;
// while unset, every caller keeps using the built-in engine, so shipping this changes nothing.

import { getDbStore } from '../mapping/store';
import { enumerateAllContacts } from '../ghl/contacts';
import { syncConnection } from './apply';
import { runPool } from './reconcile';
import type { DryRunConnection } from './dryrun';
import type { ApplyResult } from './apply';
import type { ReconcileCheckpoint, ReconcileReport } from './reconcile';
import type { CompanySyncResult, ContactSyncResult, ReconcileStats } from './types';
import type { GhlClient } from '../ghl/client';
import { ghl } from '../ghl/client';

export const CONTACT_TO_COMPANY_SLUG = 'contact-to-company';
export const COMPANY_TO_CONTACTS_SLUG = 'company-to-contacts';

/** True when the generic push-connection engine should drive real-time + reconcile (cutover flag). */
export function useGenericEngine(): boolean {
  return (process.env.SYNC_ENGINE_MODE ?? 'builtin').toLowerCase() === 'generic';
}

const bare = (k: string) => (k.includes('.') ? k.split('.').slice(1).join('.') : k);

/** Load a push connection from the DB as a DryRunConnection (null if missing/misconfigured). */
export async function loadPushConnection(slug: string): Promise<DryRunConnection | null> {
  const store = getDbStore();
  const meta = await store.getSyncMeta(slug);
  if (!meta || !meta.associationId) return null;
  const set = await store.loadSync(slug);
  return {
    sourceObject: meta.sourceObject,
    targetObject: meta.destObject,
    associationId: meta.associationId,
    rows: set.mappings.map((m) => ({
      sourceKey: m.contactKey, targetKey: m.businessKey, direction: m.direction,
      transform: m.transform, enabled: m.enabled, holdValues: m.holdValues,
    })),
  };
}

export interface ContactChangeResult {
  contactId: string;
  companyId?: string;
  up: ApplyResult;
  down: ApplyResult | null;
  companyChanged: boolean;
  /** bare company field keys written UP (for the webhook's address-gated enrichment). */
  companyFieldsWritten: string[];
}

/**
 * Real-time: a contact changed → push it UP to its primary company; if the company actually
 * changed, fan the new state DOWN to ALL the company's contacts. Mirrors syncContactUpAndFanOut,
 * but on the generic engine. Equality-guarded end to end, so it's idempotent and can't ping-pong.
 */
export async function applyContactChange(
  contactId: string,
  opts: { apply: boolean; client?: GhlClient },
): Promise<ContactChangeResult> {
  const client = opts.client ?? ghl();
  const c2c = await loadPushConnection(CONTACT_TO_COMPANY_SLUG);
  if (!c2c) throw new Error(`${CONTACT_TO_COMPANY_SLUG} connection is not configured`);

  const up = await syncConnection(c2c, contactId, { apply: opts.apply }, undefined, client);
  const fwd = up.forward[0]; // contact→company is fan-in: exactly one (primary) company
  const companyId = fwd?.targetId;
  const written = opts.apply ? (fwd?.written ?? []) : (fwd?.changes.map((c) => c.fieldKey) ?? []);
  const companyFieldsWritten = written.map(bare);
  const companyChanged = companyFieldsWritten.length > 0;

  let down: ApplyResult | null = null;
  if (companyChanged && companyId) {
    const co2c = await loadPushConnection(COMPANY_TO_CONTACTS_SLUG);
    if (co2c) down = await syncConnection(co2c, companyId, { apply: opts.apply }, undefined, client);
  }
  return { contactId, companyId, up, down, companyChanged, companyFieldsWritten };
}

/** Map one company→contacts apply result into the built-in reconcile's CompanySyncResult shape. */
function toCompanyResult(companyId: string, res: ApplyResult, apply: boolean): CompanySyncResult {
  const results: ContactSyncResult[] = res.forward.map((f) => ({
    contactId: f.targetId,
    written: apply ? f.written : f.changes.map((c) => c.fieldKey),
    companyNameWritten: false, // companyName is just another mapped field in this model
    unchanged: f.unchanged,
    skipped: f.skipped.map((s) => ({ key: s.key, value: undefined, reason: s.reason })),
    drift: f.changes.map((c) => ({ field: c.fieldKey, from: c.from, to: c.to })),
    applied: apply,
  }));
  return { companyId, contactCount: res.counterpartCount, results };
}

export interface GenericReconcileOptions {
  apply: boolean;
  client?: GhlClient;
  concurrency?: number;
  limit?: number;
  onlyCompanyIds?: string[];
  checkpoint?: ReconcileCheckpoint;
  onCompany?: (result: CompanySyncResult) => void;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Batch: sweep every company through the `company-to-contacts` push (the down direction), the
 * generic-engine equivalent of reconcileAll/syncCompanyDown. Reuses the built-in reconcile's
 * bounded pool + checkpoint + report shape so the nightly Action, progress logging, and report
 * writer work unchanged. Idempotent + equality-guarded — a clean night writes nothing.
 */
export async function reconcileAllGeneric(opts: GenericReconcileOptions): Promise<ReconcileReport> {
  const client = opts.client ?? ghl();
  const startedAt = new Date();
  const concurrency = opts.concurrency ?? 1;
  const stats: ReconcileStats = { companiesProcessed: 0, contactsProcessed: 0, contactsChanged: 0, fieldsWritten: 0, errors: [] };
  const changed: CompanySyncResult[] = [];

  const co2c = await loadPushConnection(COMPANY_TO_CONTACTS_SLUG);
  if (!co2c) throw new Error(`${COMPANY_TO_CONTACTS_SLUG} connection is not configured`);

  // Enumerate ALL contacts once and group by company (same as the built-in reconcile), so the
  // per-company sweep reuses this roster instead of re-querying contacts per company. The roster is
  // injected as resolveCounterpartIds, so syncConnection skips its listContactsByBusiness lookup —
  // that per-company search is the difference between ~30min and ~50min over 876 companies.
  const all = await enumerateAllContacts(client);
  const byCompany = new Map<string, string[]>();
  for (const c of all) {
    const b = c.businessId;
    if (!b) continue;
    if (opts.onlyCompanyIds && !opts.onlyCompanyIds.includes(b)) continue;
    const arr = byCompany.get(b) ?? [];
    arr.push(c.id);
    byCompany.set(b, arr);
  }

  const done = opts.checkpoint ? await opts.checkpoint.loadDone() : new Set<string>();
  let companyIds = Array.from(byCompany.keys());
  const companiesTotal = companyIds.length;
  let companiesSkipped = 0;
  if (done.size) companyIds = companyIds.filter((id) => { const skip = done.has(id); if (skip) companiesSkipped++; return !skip; });
  if (opts.limit != null) companyIds = companyIds.slice(0, opts.limit);

  let progressDone = companiesSkipped;
  await runPool(companyIds, concurrency, async (companyId) => {
    try {
      const roster = byCompany.get(companyId) ?? [];
      const res = await syncConnection(co2c, companyId, { apply: opts.apply }, { resolveCounterpartIds: async () => roster }, client);
      const result = toCompanyResult(companyId, res, opts.apply);
      stats.companiesProcessed++;
      stats.contactsProcessed += result.results.length;
      let companyChanged = false;
      for (const r of result.results) {
        const wrote = r.written.length;
        if (wrote > 0) { stats.contactsChanged++; stats.fieldsWritten += wrote; companyChanged = true; }
        for (const s of r.skipped) stats.errors.push({ companyId, contactId: r.contactId, message: `skipped ${s.key}: ${s.reason}` });
      }
      if (companyChanged) changed.push(result);
      opts.onCompany?.(result);
      if (opts.checkpoint) { try { await opts.checkpoint.markDone(companyId); } catch { /* best-effort */ } }
    } catch (e: any) {
      stats.errors.push({ companyId, message: e?.message ?? String(e) });
    } finally {
      progressDone++;
      opts.onProgress?.(progressDone, companiesTotal);
    }
  });

  const finishedAt = new Date();
  return {
    stats,
    changed,
    run: {
      target: process.env.GHL_TARGET ?? 'live',
      apply: opts.apply,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      concurrency,
      companiesTotal,
      companiesSkipped,
    },
  };
}
