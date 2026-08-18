// lib/webhooks/fastAck.ts — acknowledge a GHL webhook immediately, then finish the work.
//
// WHY THIS EXISTS (2026-08-18): `/api/sync/up` does a lot per contact change — push contact→company,
// fan out to the company's other contacts, company enrichment, stage scoring, an Anthropic call for
// readiness tagging, and the Wix Team sync. Measured 7.4–17.7s. GHL's webhook timeout is far shorter,
// so every contact change logged a FAILURE, hundreds accumulated, and GHL flagged the workflow
// "Needs Review" and stopped executing it altogether. Real-time sync silently died.
//
// The work itself was fine — it was the waiting that broke. So: return 202 the moment the request is
// authenticated and understood, and let the handler finish under `waitUntil`, which keeps the
// serverless invocation alive after the response is sent.
//
// SAFETY: GHL may retry a webhook it believes failed, so a payload can arrive more than once. Every
// write path here is equality-guarded (see lib/ghl/objectWrite.ts and lib/wix-sync/sync.ts), so a
// duplicate delivery converges to a no-op rather than double-writing. That guarantee is what makes
// fire-and-forget acceptable; do not adopt this pattern for a non-idempotent handler.
//
// ⛔ DISABLED BY DEFAULT — `waitUntil` DOES NOT WORK ON THIS PROJECT YET.
//
// Verified against prod 2026-08-18: the endpoint returned 202 in 1.5s, but the work never ran — a
// contact with a pending `business.logo` write still had it pending afterwards. `waitUntil` needs
// Vercel **Fluid Compute**; on the classic Node serverless runtime the invocation is frozen the
// moment the response is sent, so the continuation is simply discarded.
//
// That failure mode is worse than the timeout it was meant to fix: GHL records success and nothing
// happens — silent data loss. So async is now OPT-IN via `?async=1`, and every handler defaults to
// synchronous. Do NOT make it the default until `waitUntil` is proven on this project:
//   1. enable Fluid Compute in the Vercel project settings, then
//   2. re-run the check in the commit message (fire ?async=1 at a contact with a pending write and
//      confirm the write lands), and only then flip the defaults.
// A durable queue (DB table + cron drain) is the alternative that needs no platform feature.
//
// TRADE-OFF when it IS enabled: the caller no longer learns whether the work succeeded — 202 means
// "accepted", not "done". Outcomes go to `change_log` (queryable in /activity), and failures are
// logged server-side. `?sync=1` forces synchronous.

import type { NextApiRequest, NextApiResponse } from 'next';
import { waitUntil } from '@vercel/functions';

/** True when the caller explicitly wants to wait for the result (`?sync=1`). */
export function wantsSynchronous(req: NextApiRequest): boolean {
  return req.query.sync === '1' || req.query.wait === '1';
}

/**
 * Should this request be handled asynchronously?
 *
 * OPT-IN ONLY (`?async=1`), because `waitUntil` silently drops the work on this project's runtime —
 * see the header. Defaulting to async would ack GHL and do nothing.
 */
export function wantsAsync(req: NextApiRequest): boolean {
  return req.query.async === '1' && !wantsSynchronous(req);
}

export interface FastAckOptions {
  /** Identifies the work in logs, e.g. 'sync/up'. */
  label: string;
  /** Echoed back in the 202 body so the caller can correlate. */
  detail?: Record<string, unknown>;
}

/**
 * Run `work` without making the caller wait.
 *
 * Sends `202 Accepted` immediately, then lets the invocation continue via `waitUntil`. Errors are
 * caught and logged — an unhandled rejection here would be invisible to the caller by definition,
 * so swallowing it silently is not acceptable.
 *
 * Returns after the response is sent; the handler should `return` straight away.
 */
export function ackAndRun(
  res: NextApiResponse,
  work: () => Promise<unknown>,
  opts: FastAckOptions,
): void {
  res.status(202).json({
    ok: true,
    accepted: true,
    async: true,
    note:
      'Work started; this response does not report its outcome. See the change log (/activity) for ' +
      'what was written, or re-send with ?sync=1 to wait for the result.',
    ...opts.detail,
  });

  const started = Date.now();
  waitUntil(
    (async () => {
      try {
        await work();
        console.log(`[fastAck] ${opts.label} completed in ${Date.now() - started}ms`, opts.detail ?? {});
      } catch (e: any) {
        // The caller already got a 202, so this is the ONLY record of the failure.
        console.error(`[fastAck] ${opts.label} FAILED after ${Date.now() - started}ms:`, e?.stack ?? e, opts.detail ?? {});
      }
    })(),
  );
}
