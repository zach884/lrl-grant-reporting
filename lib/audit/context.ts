// lib/audit/context.ts — per-invocation run context for the change log.
//
// A webhook or batch run wraps its work in withRun({ runId, trigger }); every logChange() inside then
// gets tagged with the same runId + trigger, so all the writes one Contact-Changed event fans out
// across GHL + Wix can be traced as a single run. Uses AsyncLocalStorage so we don't thread a context
// argument through every sync/enricher/scorer function.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RunContext {
  runId: string;
  /** 'webhook:contact-changed' | 'batch:<script>' | 'manual' | ... */
  trigger: string;
}

const storage = new AsyncLocalStorage<RunContext>();

export function withRun<T>(ctx: RunContext, fn: () => Promise<T> | T): Promise<T> | T {
  return storage.run(ctx, fn);
}

export function currentRun(): RunContext | undefined {
  return storage.getStore();
}

/** Convenience: a run id (crypto UUID). Callers may pass their own. */
export function newRunId(): string {
  return randomUUID();
}
