// lib/activities/reportingPeriod.ts — which six-month window a Client Reporting snapshot covers.
//
// Zach, 2026-08-19: *"Client Reporting is typically done in September for an October 15th date, and
// in March for an April 15th date."* Every Metrics field asks "in the last 6 months", so each
// submission describes the half-year that just ENDED:
//
//     collected September  →  covers Mar 1 – Aug 31   (period end Aug 31)
//     collected March      →  covers Sep 1 – Feb 28/29 (period end Feb 28/29)
//
// The period is stored as a DATE (`reporting_period`), so it is stamped with the window's END —
// the most reportable form of it ("the snapshot as at 31 Aug 2026") and the one that sorts.
//
// WHY THIS MATTERS MORE THAN IT LOOKS: the period is half of the idempotency key for a metrics
// snapshot (`<contactId>:<periodEnd>`). Derive it inconsistently and either two submissions collide
// into one record, or one client ends up with two snapshots for the same half-year — and a
// follow-on-funding figure counted twice is exactly the kind of error that still looks plausible.

/** The two boundaries a reporting window can end on: end of February, end of August. */
const BOUNDARY_MONTHS = [1, 7]; // 0-indexed: February, August

/**
 * A late submission still belongs to the window it reports on, but an EARLY one is trickier: a
 * survey filled in on 25 August is plainly for the window ending 31 August, which has not closed
 * yet. So a boundary up to this many days in the future still counts as the current window.
 * Beyond that, the window is not over and the previous one is the honest answer.
 */
const EARLY_GRACE_DAYS = 21;

const endOfMonth = (year: number, monthIndex: number) => new Date(Date.UTC(year, monthIndex + 1, 0));

/** Every Feb-end / Aug-end boundary around a date, nearest first. */
function boundariesNear(at: Date): Date[] {
  const y = at.getUTCFullYear();
  const out: Date[] = [];
  for (const year of [y - 1, y, y + 1]) for (const m of BOUNDARY_MONTHS) out.push(endOfMonth(year, m));
  return out.sort((a, b) => Math.abs(a.getTime() - at.getTime()) - Math.abs(b.getTime() - at.getTime()));
}

export interface ReportingPeriod {
  /** Last day of the six-month window, as YYYY-MM-DD. This is what `reporting_period` stores. */
  end: string;
  /** First day of the window, for display and for report-time filtering. */
  start: string;
  /** "Mar–Aug 2026" / "Sep 2025–Feb 2026". */
  label: string;
}

/**
 * The reporting period a submission on `submittedAt` describes.
 *
 * Picks the nearest Feb-end/Aug-end boundary that has already passed, allowing one up to
 * EARLY_GRACE_DAYS in the future (see above). Deterministic: the same submission date always yields
 * the same period, which is what makes it safe to use as an idempotency key.
 */
export function reportingPeriodFor(submittedAt: Date | string): ReportingPeriod {
  const at = typeof submittedAt === 'string' ? new Date(submittedAt) : submittedAt;
  if (Number.isNaN(at.getTime())) throw new Error(`reportingPeriodFor: unparseable date ${String(submittedAt)}`);

  const graceMs = EARLY_GRACE_DAYS * 86400000;
  const end =
    boundariesNear(at).find((b) => b.getTime() <= at.getTime() + graceMs) ??
    endOfMonth(at.getUTCFullYear() - 1, BOUNDARY_MONTHS[1]);

  // The window is the six months ending on that boundary.
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 5, 1));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const mon = (d: Date) => d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const label =
    start.getUTCFullYear() === end.getUTCFullYear()
      ? `${mon(start)}–${mon(end)} ${end.getUTCFullYear()}`
      : `${mon(start)} ${start.getUTCFullYear()}–${mon(end)} ${end.getUTCFullYear()}`;

  return { end: iso(end), start: iso(start), label };
}
