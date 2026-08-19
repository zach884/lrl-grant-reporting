// Which half-year a Client Reporting submission describes. Zach's cadence: collected in September
// (Oct 15 due) and in March (Apr 15 due), each covering the six months just ended.
//
// This is half of the metrics idempotency key, so a wrong answer either collides two submissions or
// gives one client two snapshots for the same half-year.

import { describe, it, expect } from 'vitest';
import { reportingPeriodFor } from '../reportingPeriod';

describe('reportingPeriodFor', () => {
  it('maps the September collection to the Mar–Aug window', () => {
    expect(reportingPeriodFor('2026-09-12')).toMatchObject({
      start: '2026-03-01', end: '2026-08-31', label: 'Mar–Aug 2026',
    });
  });

  it('maps the March collection to the Sep–Feb window that just ended', () => {
    expect(reportingPeriodFor('2026-03-08')).toMatchObject({
      start: '2025-09-01', end: '2026-02-28', label: 'Sep 2025–Feb 2026',
    });
  });

  it('handles a leap year\'s February boundary', () => {
    expect(reportingPeriodFor('2028-03-08').end).toBe('2028-02-29');
  });

  it('keeps a straggler in the window it reports on', () => {
    // The Oct 15 due date means submissions arrive well after the window closed.
    expect(reportingPeriodFor('2026-10-14').end).toBe('2026-08-31');
    expect(reportingPeriodFor('2026-04-15').end).toBe('2026-02-28');
  });

  it('counts an early submission for the window about to close', () => {
    // Filled in on 25 August: plainly the Mar–Aug window, which ends in six days.
    expect(reportingPeriodFor('2026-08-25').end).toBe('2026-08-31');
  });

  it('does NOT pull a mid-cycle submission into a window that has not happened', () => {
    // June is nearer to Aug 31 than to Feb 28, but that half-year is still running.
    expect(reportingPeriodFor('2026-06-10').end).toBe('2026-02-28');
  });

  it('is stable across a year boundary', () => {
    expect(reportingPeriodFor('2027-01-05').end).toBe('2026-08-31');
    expect(reportingPeriodFor('2026-12-31').end).toBe('2026-08-31');
  });

  it('is deterministic — the same submission always yields the same key', () => {
    const a = reportingPeriodFor('2026-09-12T14:03:22.000Z');
    const b = reportingPeriodFor(new Date('2026-09-12T23:59:59.000Z'));
    expect(a.end).toBe(b.end);
  });

  it('refuses an unparseable date rather than inventing a period', () => {
    expect(() => reportingPeriodFor('not a date')).toThrow(/unparseable/);
  });
});
