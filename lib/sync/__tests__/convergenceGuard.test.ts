import { describe, it, expect } from 'vitest';
import { valueKey, shouldSuppress } from '../convergenceGuard';

describe('valueKey', () => {
  it('normalizes scalars and orders arrays', () => {
    expect(valueKey('United States')).toBe('united states');
    expect(valueKey(' US ')).toBe('us');
    expect(valueKey(0)).toBe('0');
    expect(valueKey(null)).toBe('');
    expect(valueKey(['B', 'a'])).toBe('a|b');
  });
});

describe('shouldSuppress (the country-loop case)', () => {
  it('suppresses re-proposing a value we already wrote that did not stick', () => {
    // last wrote "United States"; field reverted to "US"; about to write "United States" again → loop.
    expect(shouldSuppress({ fieldKey: 'country', from: 'US', to: 'United States' }, valueKey('United States'))).toBe(true);
  });
  it('does NOT suppress a genuinely new value (different from what we last wrote)', () => {
    expect(shouldSuppress({ fieldKey: 'country', from: 'US', to: 'Canada' }, valueKey('United States'))).toBe(false);
  });
  it('does NOT suppress the first write (no ledger entry)', () => {
    expect(shouldSuppress({ fieldKey: 'country', from: 'US', to: 'United States' }, null)).toBe(false);
  });
  it('does NOT suppress when the field actually holds what we wrote (converged)', () => {
    // from already equals to → not a diff that loops (and diff wouldn't have proposed it anyway).
    expect(shouldSuppress({ fieldKey: 'x', from: 'United States', to: 'United States' }, valueKey('United States'))).toBe(false);
  });
});

// ─── oscillation (added after the 2026-08-27 company-name loop) ─────────────────────────────────
import {
  shouldSuppressOscillation, appendRecent, OSCILLATION_WINDOW_MS, MAX_WRITES_IN_WINDOW, RECENT_LIMIT,
} from '../convergenceGuard';

describe('shouldSuppressOscillation', () => {
  const NOW = 1_700_000_000_000;
  const ago = (ms: number) => NOW - ms;
  const change = (from: unknown, to: unknown) => ({ fieldKey: 'business.name', from, to });

  it('allows a write when there is no history', () => {
    expect(shouldSuppressOscillation(change('A', 'B'), [], NOW)).toBeNull();
    expect(shouldSuppressOscillation(change('A', 'B'), null, NOW)).toBeNull();
  });

  it('catches the A→B→A flip-flop the old guard was blind to', () => {
    // We wrote "Grand Rapids SmartZone" 8s ago; the field now reads Burgess and we are about to
    // write Grand Rapids again. That is the loop, and last_value alone could never see it.
    const recent = [{ v: 'burgess institute', t: ago(4000) }, { v: 'grand rapids smartzone', t: ago(8000) }];
    const d = shouldSuppressOscillation(change('Burgess Institute', 'Grand Rapids SmartZone'), recent, NOW);
    expect(d?.kind).toBe('oscillation');
    expect(d?.reason).toContain('8s ago');
    expect(d?.reason).toContain('mapped in both directions');
  });

  it('allows restoring an old value once it is outside the window', () => {
    // The same shape, but weeks apart: a real correction, not a loop.
    const recent = [{ v: 'grand rapids smartzone', t: ago(OSCILLATION_WINDOW_MS + 60_000) }];
    expect(shouldSuppressOscillation(change('Burgess', 'Grand Rapids SmartZone'), recent, NOW)).toBeNull();
  });

  it('allows a genuinely new value even with recent history', () => {
    const recent = [{ v: 'a', t: ago(1000) }, { v: 'b', t: ago(2000) }];
    expect(shouldSuppressOscillation(change('a', 'c'), recent, NOW)).toBeNull();
  });

  it('trips the rate breaker on a longer cycle no value check would catch', () => {
    // A→B→C→D→A: four distinct recent values, and the fifth write is a brand-new one.
    const recent = [
      { v: 'd', t: ago(1000) }, { v: 'c', t: ago(2000) },
      { v: 'b', t: ago(3000) }, { v: 'a', t: ago(4000) },
    ];
    const d = shouldSuppressOscillation(change('d', 'e'), recent, NOW);
    expect(d?.kind).toBe('rate');
    expect(d?.reason).toContain('4 writes');
  });

  it('does not trip the rate breaker on writes that fall outside the window', () => {
    const old = OSCILLATION_WINDOW_MS + 1000;
    const recent = [
      { v: 'd', t: ago(old) }, { v: 'c', t: ago(old) },
      { v: 'b', t: ago(old) }, { v: 'a', t: ago(old) },
    ];
    expect(shouldSuppressOscillation(change('d', 'e'), recent, NOW)).toBeNull();
  });

  it('normalizes values the same way the ledger does', () => {
    const recent = [{ v: 'grand rapids smartzone', t: ago(1000) }];
    // Different case and padding — still the same value, still a loop.
    const d = shouldSuppressOscillation(change('Burgess', '  GRAND RAPIDS SmartZone '), recent, NOW);
    expect(d?.kind).toBe('oscillation');
  });

  it('respects a caller-supplied window and threshold', () => {
    const recent = [{ v: 'a', t: ago(5000) }];
    expect(shouldSuppressOscillation(change('b', 'a'), recent, NOW, { windowMs: 1000 })).toBeNull();
    expect(shouldSuppressOscillation(change('b', 'a'), recent, NOW, { windowMs: 10_000 })?.kind).toBe('oscillation');
  });

  it('would have stopped the real incident within a few writes', () => {
    // Replay the actual alternation. Once two values are in the window, every further write of
    // either one is suppressed — so the storm cannot pass ~3 writes per field.
    const A = 'Grand Rapids SmartZone';
    const B = 'Burgess Institute for Entrepreneurship & Innovation';
    let recent: Array<{ v: string; t: number }> = [];
    let allowed = 0;
    let current = A;
    for (let i = 0; i < 47; i += 1) {
      const next = current === A ? B : A;
      const t = NOW + i * 5000; // the real writes were seconds apart
      if (!shouldSuppressOscillation({ fieldKey: 'business.name', from: current, to: next }, recent, t)) {
        allowed += 1;
        recent = appendRecent(recent, next, t);
        current = next;
      }
    }
    expect(allowed).toBeLessThanOrEqual(3);
  });
});

describe('appendRecent', () => {
  it('puts the newest entry first and normalizes it', () => {
    const r = appendRecent([{ v: 'old', t: 1 }], '  NEW  ', 2);
    expect(r[0]).toEqual({ v: 'new', t: 2 });
    expect(r[1]).toEqual({ v: 'old', t: 1 });
  });
  it('bounds the history', () => {
    let r: Array<{ v: string; t: number }> = [];
    for (let i = 0; i < RECENT_LIMIT + 5; i += 1) r = appendRecent(r, `v${i}`, i);
    expect(r).toHaveLength(RECENT_LIMIT);
    expect(r[0].v).toBe(`v${RECENT_LIMIT + 4}`);
  });
  it('treats a missing history as empty', () => {
    expect(appendRecent(null, 'x', 1)).toEqual([{ v: 'x', t: 1 }]);
  });
});

describe('the thresholds are sane', () => {
  it('a window long enough to cover a webhook storm, short enough to allow real corrections', () => {
    expect(OSCILLATION_WINDOW_MS).toBeGreaterThanOrEqual(60_000);
    expect(MAX_WRITES_IN_WINDOW).toBeGreaterThan(1);
  });
});
