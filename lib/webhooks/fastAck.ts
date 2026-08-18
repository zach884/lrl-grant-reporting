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
// ✅ VERIFIED WORKING ON PROD 2026-08-18, and it DEPENDS ON VERCEL FLUID COMPUTE.
//
// Proof: cleared a Team row's `image_fldSrc` (invisible on the site, but a guaranteed pending write),
// fired `?async=1`, got 202 in 1.4s, and the column was restored ~15s later without the caller
// waiting. Two earlier attempts to verify this were WRONG and worth recording so nobody re-derives
// them: the first probed `business.logo`, whose write GHL rejects for unrelated reasons, so nothing
// could ever land; the second read the result back within a second or two of the 202, before ~14s of
// work could finish. Both looked exactly like "waitUntil is broken".
//
// ⚠️ FLUID COMPUTE IS LOAD-BEARING. On the classic Node serverless runtime the invocation is frozen
// the moment the response is sent and the continuation is silently discarded — GHL would record
// success while nothing happened. If Fluid Compute is ever turned off for this project, these
// handlers MUST go back to synchronous (`wantsAsync` returning false is enough). The nightly
// reconcile/readiness/resources Actions are the backstop that would eventually paper over it, which
// is precisely why the failure would be hard to notice.
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
 * Should this request be handled asynchronously? Default YES — that is the whole point.
 *
 * A dry run is for a human who wants the plan, and `?sync=1` forces waiting, so both stay
 * synchronous. Everything else (i.e. a real GHL webhook delivery) gets acked immediately.
 */
export function wantsAsync(req: NextApiRequest): boolean {
  if (wantsSynchronous(req)) return false;
  const dryRun = req.query.dryRun === '1' || (req.body as any)?.dryRun === true;
  return !dryRun;
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
