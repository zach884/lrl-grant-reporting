import { describe, it, expect } from 'vitest';
import {
  toGhlDate,
  resolveOptionLabel,
  optionKeyToLabel,
  coerceBusinessProperties,
  isUnwritable,
} from '../coerce';
import { GhlUnwritableFieldError } from '../errors';
import type { CustomFieldDef } from '../types';

const catalog: Record<string, CustomFieldDef> = {
  'business.lara_id': { id: '1', name: 'LARA ID', fieldKey: 'business.lara_id', dataType: 'NUMERICAL' },
  'business.date_of_incorporation': {
    id: '2', name: 'Inc Date', fieldKey: 'business.date_of_incorporation', dataType: 'DATE',
  },
  'business.county': {
    id: '3', name: 'County', fieldKey: 'business.county', dataType: 'SINGLE_OPTIONS',
    options: [
      { key: 'jackson_county_mi', label: 'Jackson County (MI)' },
      { key: 'iii_d', label: 'III - D' },
    ],
  },
  'business.problem': { id: '4', name: 'Problem', fieldKey: 'business.problem', dataType: 'LARGE_TEXT' },
  'business.i_am_selling': {
    id: '5', name: 'Selling', fieldKey: 'business.i_am_selling', dataType: 'MULTIPLE_OPTIONS',
  },
};

describe('toGhlDate', () => {
  it('expands a date-only string to full ISO (the silently-dropped quirk)', () => {
    expect(toGhlDate('2026-06-29')).toBe('2026-06-29T00:00:00Z');
  });
  it('passes through an existing datetime', () => {
    expect(toGhlDate('2026-06-29T12:00:00Z')).toBe('2026-06-29T12:00:00Z');
  });
  it('returns null for empty', () => {
    expect(toGhlDate('')).toBeNull();
    expect(toGhlDate(null)).toBeNull();
  });
});

describe('resolveOptionLabel', () => {
  const opts = catalog['business.county'].options!;
  it('resolves an exact label', () => {
    expect(resolveOptionLabel('Jackson County (MI)', opts)).toBe('Jackson County (MI)');
  });
  it('resolves a stored key back to the label to send', () => {
    expect(resolveOptionLabel('jackson_county_mi', opts)).toBe('Jackson County (MI)');
  });
  it('tolerates spacing/case drift (III-D vs III - D)', () => {
    expect(resolveOptionLabel('III-D', opts)).toBe('III - D');
  });
  it('returns null when nothing matches', () => {
    expect(resolveOptionLabel('Nowhere County', opts)).toBeNull();
  });
});

describe('optionKeyToLabel', () => {
  it('maps a stored key to its display label', () => {
    expect(optionKeyToLabel('jackson_county_mi', catalog['business.county'].options)).toBe(
      'Jackson County (MI)',
    );
  });
});

describe('coerceBusinessProperties', () => {
  it('coerces numbers to int, dates to ISO, single-selects to label', () => {
    const { properties } = coerceBusinessProperties(
      {
        'business.lara_id': '123456',
        date_of_incorporation: '2026-07-07',
        county: 'jackson_county_mi',
        problem: 'We help manufacturers.',
      },
      catalog,
    );
    expect(properties).toEqual({
      lara_id: 123456,
      date_of_incorporation: '2026-07-07T00:00:00Z',
      county: 'Jackson County (MI)',
      problem: 'We help manufacturers.',
    });
  });

  it('skips empty values and unmatched options rather than sending garbage', () => {
    const { properties, skipped } = coerceBusinessProperties(
      { county: 'Nowhere County', problem: '' },
      catalog,
    );
    expect(properties).toEqual({});
    expect(skipped).toContainEqual({ key: 'county', value: 'Nowhere County', reason: 'no matching option' });
  });

  it('throws on unwritable field types (MULTIPLE_OPTIONS/CHECKBOX/TEXTBOX_LIST)', () => {
    expect(() =>
      coerceBusinessProperties({ i_am_selling: 'Products' }, catalog),
    ).toThrow(GhlUnwritableFieldError);
  });

  it('accepts both prefixed and bare keys', () => {
    const { properties } = coerceBusinessProperties({ 'business.lara_id': 7, lara_id: 7 }, catalog);
    expect(properties).toEqual({ lara_id: 7 });
  });
});

describe('isUnwritable', () => {
  it('flags the API-hostile types', () => {
    expect(isUnwritable('CHECKBOX')).toBe(true);
    expect(isUnwritable('TEXTBOX_LIST')).toBe(true);
    expect(isUnwritable('MULTIPLE_OPTIONS')).toBe(true);
    expect(isUnwritable('TEXT')).toBe(false);
    expect(isUnwritable('SINGLE_OPTIONS')).toBe(false);
  });
});
