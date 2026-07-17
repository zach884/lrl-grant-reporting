// lib/sync/reconcile.ts — the scheduled DOWN-sync sweep.
//
// Native GHL workflows are best-effort; THIS is the guarantee. It re-pushes every
// company's mirrored fields to all associated contacts and logs any drift it corrects.
// Run nightly / pre-reporting. Equality-guarded, so a clean run writes nothing.
//
// Hardened for LIVE scale (~868 companies / ~1,050 linked contacts):
//  - bounded concurrency (a company pool; each company still syncs its contacts serially)
//  - resumability via an optional checkpoint (skip companies already done)
//  - a bounded `limit` for staged first runs, and an `onProgress` callback
//  - a structured run report (target/apply/timings/stats/drift) it can persist to disk
// All of this is additive — the original `reconcileAll(mappings, catalogs, {apply})` call
// still behaves exactly as before (concurrency defaults to 1, no checkpoint, no report file).

import { promises as fs } from 'node:fs';
import { GhlClient, ghl } from '../ghl/client';
import { CustomFieldCatalog, Contact } from '../ghl/types';
import { enumerateAllContacts } from '../ghl/contacts';
import type { FieldMapping } from '../mapping/types';
import { syncCompanyDown } from './downsync';
import { CompanySyncResult, ReconcileStats } from './types';

/** Resumability hook. Company-granular: a company is "done" once fully processed. */
export interface ReconcileCheckpoint {
  loadDone(): Promise<Set<string>>;
  markDone(companyId: string): Promise<void>;
}

/**
 * File-backed checkpoint (append-only JSONL of {companyId,ts}). Safe to re-run:
 * down-sync is idempotent, so the checkpoint is a speed/robustness aid, not a
 * correctness requirement.
 */
export class FileReconcileCheckpoint implements ReconcileCheckpoint {
  constructor(private readonly path: string) {}
  async loadDone(): Promise<Set<string>> {
    try {
      const txt = await fs.readFile(this.path, 'utf8');
      const done = new Set<string>();
      for (const line of txt.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { const o = JSON.parse(t); if (o.companyId) done.add(o.companyId); } catch { /* skip bad line */ }
      }
      return done;
    } catch (e: any) {
      if (e?.code === 'ENOENT') return new Set();
      throw e;
    }
  }
  async markDone(companyId: string): Promise<void> {
    await fs.appendFile(this.path, JSON.stringify({ companyId, ts: new Date().toISOString() }) + '\n', 'utf8');
  }
}

export interface ReconcileOptions {
  apply: boolean;
  client?: GhlClient;
  /** Called after each company is processed (for progress UIs / logs). */
  onCompany?: (result: CompanySyncResult) => void;
  /** Called after each company finishes, with running counts (done includes skipped). */
  onProgress?: (done: number, total: number) => void;
  /** Limit to specific company ids (else all companies that have contacts). */
  onlyCompanyIds?: string[];
  /** How many companies to process in parallel (default 1 = original behavior). */
  concurrency?: number;
  /** Process at most this many companies this run (staged first passes). */
  limit?: number;
  /** Skip companies already recorded done, and record each as it completes. */
  checkpoint?: ReconcileCheckpoint;
  /** Pre-fetched contacts (skips the full enumerate — for tests / chained runs). */
  contacts?: Contact[];
}

export interface ReconcileReport {
  stats: ReconcileStats;
  /** companies whose contacts drifted (had at least one write). */
  changed: CompanySyncResult[];
  /** run metadata (present on every run; useful when persisted). */
  run: {
    target: string;
    apply: boolean;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    concurrency: number;
    companiesTotal: number; // companies with contacts in scope this run
    companiesSkipped: number; // skipped via checkpoint
  };
}

/** Simple bounded worker pool preserving safe (single-threaded) stat mutation. */
export async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const n = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const runners = Array.from({ length: n }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

/**
 * Group all contacts by businessId and re-push each company's mirrored state.
 * Reads all contacts once (light), then syncCompanyDown re-reads each contact's
 * custom fields (needed for the equality guard) and the company record once.
 */
export async function reconcileAll(
  mappings: FieldMapping[],
  catalogs: { business: CustomFieldCatalog; contact: CustomFieldCatalog },
  opts: ReconcileOptions,
): Promise<ReconcileReport> {
  const client = opts.client ?? ghl();
  const startedAt = new Date();
  const concurrency = opts.concurrency ?? 1;
  const stats: ReconcileStats = {
    companiesProcessed: 0,
    contactsProcessed: 0,
    contactsChanged: 0,
    fieldsWritten: 0,
    errors: [],
  };
  const changed: CompanySyncResult[] = [];

  // Group contacts by company.
  const byCompany = new Map<string, Contact[]>();
  const all = opts.contacts ?? (await enumerateAllContacts(client));
  for (const c of all) {
    if (!c.businessId) continue;
    if (opts.onlyCompanyIds && !opts.onlyCompanyIds.includes(c.businessId)) continue;
    const arr = byCompany.get(c.businessId) ?? [];
    arr.push(c);
    byCompany.set(c.businessId, arr);
  }

  // Resumability: drop already-done companies.
  const done = opts.checkpoint ? await opts.checkpoint.loadDone() : new Set<string>();
  let entries = Array.from(byCompany.entries());
  const companiesTotal = entries.length;
  let companiesSkipped = 0;
  if (done.size) {
    entries = entries.filter(([id]) => {
      const skip = done.has(id);
      if (skip) companiesSkipped++;
      return !skip;
    });
  }
  if (opts.limit != null) entries = entries.slice(0, opts.limit);

  let progressDone = companiesSkipped;
  const total = companiesTotal;

  await runPool(entries, concurrency, async ([companyId, contacts]) => {
    try {
      const result = await syncCompanyDown(companyId, mappings, catalogs, {
        apply: opts.apply,
        client,
        contacts,
      });
      stats.companiesProcessed++;
      stats.contactsProcessed += result.results.length;
      let companyChanged = false;
      for (const r of result.results) {
        const wrote = r.written.length + (r.companyNameWritten ? 1 : 0);
        if (wrote > 0) { stats.contactsChanged++; stats.fieldsWritten += wrote; companyChanged = true; }
        for (const s of r.skipped) {
          stats.errors.push({ companyId, contactId: r.contactId, message: `skipped ${s.key}: ${s.reason}` });
        }
      }
      if (companyChanged) changed.push(result);
      opts.onCompany?.(result);
      // Mark done ONLY on success — an errored company must be retried on resume,
      // not silently skipped.
      if (opts.checkpoint) { try { await opts.checkpoint.markDone(companyId); } catch { /* best-effort */ } }
    } catch (e: any) {
      stats.errors.push({ companyId, message: e?.message ?? String(e) });
    } finally {
      progressDone++;
      opts.onProgress?.(progressDone, total);
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

/**
 * Render a report to a compact human summary + optionally persist the full JSON
 * (and a drift log) to disk. Returns the summary string.
 */
export async function writeReconcileReport(
  report: ReconcileReport,
  opts: { jsonPath?: string; driftPath?: string } = {},
): Promise<string> {
  const { stats, changed, run } = report;
  const lines: string[] = [];
  lines.push(`Reconcile ${run.apply ? 'APPLY' : 'DRY-RUN'} on ${run.target}`);
  lines.push(`  ${run.startedAt} -> ${run.finishedAt} (${(run.durationMs / 1000).toFixed(1)}s, concurrency ${run.concurrency})`);
  lines.push(`  companies: ${stats.companiesProcessed} processed, ${run.companiesSkipped} skipped (checkpoint), ${run.companiesTotal} in scope`);
  lines.push(`  contacts:  ${stats.contactsProcessed} processed, ${stats.contactsChanged} ${run.apply ? 'changed' : 'would change'}`);
  lines.push(`  fields:    ${stats.fieldsWritten} ${run.apply ? 'written' : 'would write'}`);
  lines.push(`  errors/skips: ${stats.errors.length}`);

  if (opts.jsonPath) await fs.writeFile(opts.jsonPath, JSON.stringify(report, null, 2), 'utf8');
  if (opts.driftPath) {
    const drift: string[] = [];
    for (const co of changed) {
      for (const r of co.results) {
        for (const d of r.drift) {
          drift.push(JSON.stringify({
            companyId: co.companyId, companyName: co.companyName,
            contactId: r.contactId, field: d.field, from: d.from, to: d.to,
          }));
        }
      }
    }
    await fs.writeFile(opts.driftPath, drift.join('\n') + (drift.length ? '\n' : ''), 'utf8');
    lines.push(`  drift rows: ${drift.length} -> ${opts.driftPath}`);
  }
  return lines.join('\n');
}
