// lib/sync/reconcile.ts — shared reconcile infrastructure (bounded pool, checkpoint, run report).
//
// The all-companies sweep itself now lives in lib/sync/orchestrate.ts (reconcileAllGeneric), on the
// generic push-connection engine. This module holds the reusable pieces both the sweep and the CLI
// depend on: a bounded worker pool, a resumable file checkpoint, and the report type + renderer.
// (Historically this file also held the built-in contact↔company down-sync `reconcileAll`; that
// engine was retired once the generic engine reached full parity — see git history.)

import { promises as fs } from 'node:fs';
import type { CompanySyncResult, ReconcileStats } from './types';

/** Resumability hook. Company-granular: a company is "done" once fully processed. */
export interface ReconcileCheckpoint {
  loadDone(): Promise<Set<string>>;
  markDone(companyId: string): Promise<void>;
}

/**
 * File-backed checkpoint (append-only JSONL of {companyId,ts}). Safe to re-run:
 * the sweep is idempotent, so the checkpoint is a speed/robustness aid, not a
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
