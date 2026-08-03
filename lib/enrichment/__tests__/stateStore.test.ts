import { describe, it, expect } from 'vitest';
import { fingerprint, normalizeCompanyAddress, addressNeedsGeocode } from '../stateStore';

describe('fingerprint', () => {
  it('is stable for the same input and differs when the input changes', () => {
    const a = fingerprint('Company: Acme\nAnnual revenue: $0');
    expect(a).toBe(fingerprint('Company: Acme\nAnnual revenue: $0'));
    expect(a).not.toBe(fingerprint('Company: Acme\nAnnual revenue: $100000'));
    expect(a).toMatch(/^[0-9a-f]{40}$/); // sha1 hex
  });
});

describe('normalizeCompanyAddress', () => {
  const of = (m: Record<string, unknown>) => (k: string) => m[k];
  it('joins address fields lowercased, empty when none present', () => {
    expect(normalizeCompanyAddress(of({ 'business.address': '305 Moorman Drive', 'business.city': 'Jackson', 'business.state': 'Michigan', 'business.postalcode': '49202' })))
      .toBe('305 moorman drive|jackson|michigan|49202');
    expect(normalizeCompanyAddress(of({}))).toBe('');
  });
});

describe('addressNeedsGeocode', () => {
  it('runs on create (no stored address) and on a real change, skips when unchanged or no address', () => {
    expect(addressNeedsGeocode('a|b|c|d', null)).toBe(true);       // never geocoded → run
    expect(addressNeedsGeocode('a|b|c|d', 'x|y|z|w')).toBe(true);  // changed → run
    expect(addressNeedsGeocode('a|b|c|d', 'a|b|c|d')).toBe(false); // unchanged → skip
    expect(addressNeedsGeocode('', null)).toBe(false);            // no address → nothing to do
  });
});
