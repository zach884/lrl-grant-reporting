import { describe, it, expect } from 'vitest';
import { coerceToWix, isUnwritableWixType } from '../coerce';
import type { GhlFieldOption } from '../../ghl/types';

const opts: GhlFieldOption[] = [
  { key: 'hubzone', label: 'HUBZone' },
  { key: 'oz', label: 'Opportunity Zone' },
];

describe('coerceToWix — simple types', () => {
  it('passes TEXT through trimmed', () => {
    expect(coerceToWix('  hi  ', 'scalar', 'TEXT')).toEqual({ kind: 'value', value: 'hi' });
  });

  it('skips empty / null / empty-array (never overwrite with blank)', () => {
    expect(coerceToWix('', 'scalar', 'TEXT').kind).toBe('skip');
    expect(coerceToWix(null, 'scalar', 'TEXT').kind).toBe('skip');
    expect(coerceToWix([], 'MULTIPLE_OPTIONS', 'ARRAY_STRING').kind).toBe('skip');
  });

  it('coerces NUMBER and rejects non-numbers', () => {
    expect(coerceToWix('42', 'NUMERICAL', 'NUMBER')).toEqual({ kind: 'value', value: 42 });
    expect(coerceToWix('abc', 'NUMERICAL', 'NUMBER').kind).toBe('skip');
  });

  it('normalizes URL scheme', () => {
    expect(coerceToWix('example.com', 'scalar', 'URL')).toEqual({ kind: 'value', value: 'https://example.com' });
    expect(coerceToWix('https://x.io', 'scalar', 'URL')).toEqual({ kind: 'value', value: 'https://x.io' });
  });

  it('wraps plain text as HTML for RICH_TEXT', () => {
    expect(coerceToWix('Founder', 'scalar', 'RICH_TEXT')).toEqual({ kind: 'value', value: '<p>Founder</p>' });
  });

  it('formats DATE as a {$date} ISO value', () => {
    expect(coerceToWix('2026-07-16', 'DATE', 'DATETIME')).toEqual({ kind: 'value', value: { $date: '2026-07-16T00:00:00Z' } });
  });

  it('builds ARRAY_STRING from a multi-select', () => {
    const r = coerceToWix(['a', 'b'], 'MULTIPLE_OPTIONS', 'ARRAY_STRING');
    expect(r).toEqual({ kind: 'value', value: ['a', 'b'] });
  });
});

describe('coerceToWix — option -> text label', () => {
  it('resolves a SINGLE_OPTIONS key to its label for a TEXT column', () => {
    expect(coerceToWix('hubzone', 'SINGLE_OPTIONS', 'TEXT', undefined, opts)).toEqual({ kind: 'value', value: 'HUBZone' });
  });
});

describe('coerceToWix — image intent', () => {
  it('extracts a url from a GHL FILE_UPLOAD array', () => {
    const r = coerceToWix([{ url: 'https://ghl.example/photo.jpg' }], 'FILE_UPLOAD', 'IMAGE');
    expect(r).toEqual({ kind: 'image', sourceUrl: 'https://ghl.example/photo.jpg' });
  });
  it('accepts a raw url string', () => {
    const r = coerceToWix('https://ghl.example/p.png', 'scalar', 'IMAGE');
    expect(r).toEqual({ kind: 'image', sourceUrl: 'https://ghl.example/p.png' });
  });
  it('skips when no file url present', () => {
    expect(coerceToWix({ documentId: 'x' }, 'FILE_UPLOAD', 'IMAGE').kind).toBe('skip');
  });
});

describe('coerceToWix — reference intent', () => {
  it('resolves option keys to labels for a MULTI_REFERENCE target', () => {
    const r = coerceToWix(['hubzone', 'oz'], 'MULTIPLE_OPTIONS', 'MULTI_REFERENCE', undefined, opts);
    expect(r).toEqual({ kind: 'reference', labels: ['HUBZone', 'Opportunity Zone'] });
  });
  it('splits a delimited string into reference labels', () => {
    const r = coerceToWix('Alpha; Beta', 'scalar', 'REFERENCE');
    expect(r).toEqual({ kind: 'reference', labels: ['Alpha', 'Beta'] });
  });
});

describe('isUnwritableWixType', () => {
  it('flags system fields and PAGE_LINK', () => {
    expect(isUnwritableWixType('TEXT', true)).toBe(true);
    expect(isUnwritableWixType('PAGE_LINK')).toBe(true);
    expect(isUnwritableWixType('TEXT')).toBe(false);
  });
});
