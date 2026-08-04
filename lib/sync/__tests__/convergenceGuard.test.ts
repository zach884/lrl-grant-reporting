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
