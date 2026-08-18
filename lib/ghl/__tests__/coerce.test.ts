import { describe, it, expect } from 'vitest';
import {
  toGhlDate,
  resolveOptionLabel,
  optionKeyToLabel,
  coerceBusinessProperties,
  isUnwritable,
  isCreateOnly,
  isWritableInMode,
  isModifierType,
} from '../coerce';
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
    options: [
      { key: 'product', label: 'Product' },
      { key: 'service', label: 'Service' },
      { key: 'both', label: 'Both' },
    ],
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

  // Corrected 2026-08-17: object multi-selects ARE updatable, via an {add,remove} modifier.
  // The old "immutable via update" rule came from only ever sending values.
  it('emits a MULTIPLE_OPTIONS modifier intent on update, never a bare value', () => {
    const { properties, modifiers } = coerceBusinessProperties(
      { i_am_selling: 'Product' }, // default mode = update
      catalog,
    );
    // Critically: NOT in properties. A plain string there returns 200 and nulls the field.
    expect(properties).toEqual({});
    expect(modifiers).toEqual({ i_am_selling: { kind: 'options', desired: ['product'] } });
  });

  it('resolves multi-select labels to option KEYS in the modifier (labels are a silent no-op)', () => {
    const { modifiers } = coerceBusinessProperties({ i_am_selling: ['Product', 'Both'] }, catalog);
    expect(modifiers.i_am_selling.desired).toEqual(['product', 'both']);
  });

  it('accepts MULTIPLE_OPTIONS on create as an array of option KEYS', () => {
    const { properties } = coerceBusinessProperties(
      { i_am_selling: ['Product', 'service'] }, // mix of label + key
      catalog,
      'create',
    );
    expect(properties).toEqual({ i_am_selling: ['product', 'service'] });
  });

  it('splits a comma string into multi-select keys on create', () => {
    const { properties } = coerceBusinessProperties(
      { i_am_selling: 'Product, Both' },
      catalog,
      'create',
    );
    expect(properties).toEqual({ i_am_selling: ['product', 'both'] });
  });

  it('accepts both prefixed and bare keys', () => {
    const { properties } = coerceBusinessProperties({ 'business.lara_id': 7, lara_id: 7 }, catalog);
    expect(properties).toEqual({ lara_id: 7 });
  });
});

describe('writability classification', () => {
  it('TEXTBOX_LIST is not writable via the API', () => {
    expect(isUnwritable('TEXTBOX_LIST')).toBe(true);
  });
  // Re-probed live 2026-08-17 (scripts-ts/probe-checkbox-writability.ts): the {add,remove}
  // modifier persists on CHECKBOX, so it was never unwritable — only mis-measured.
  it('CHECKBOX is writable via the modifier, like MULTIPLE_OPTIONS', () => {
    expect(isUnwritable('CHECKBOX')).toBe(false);
    expect(isModifierType('CHECKBOX')).toBe(true);
    expect(isWritableInMode('CHECKBOX', 'update')).toBe(true);
  });
  it('MULTIPLE_OPTIONS is writable in BOTH modes — via a modifier on update', () => {
    expect(isUnwritable('MULTIPLE_OPTIONS')).toBe(false);
    expect(isCreateOnly('MULTIPLE_OPTIONS')).toBe(false);
    expect(isWritableInMode('MULTIPLE_OPTIONS', 'create')).toBe(true);
    expect(isWritableInMode('MULTIPLE_OPTIONS', 'update')).toBe(true);
    expect(isModifierType('MULTIPLE_OPTIONS')).toBe(true);
  });
  it('FILE_UPLOAD is a modifier type too ({add:[{url}]})', () => {
    expect(isModifierType('FILE_UPLOAD')).toBe(true);
    expect(isModifierType('TEXT')).toBe(false);
  });
  it('ordinary types are writable in both modes', () => {
    expect(isUnwritable('TEXT')).toBe(false);
    expect(isCreateOnly('SINGLE_OPTIONS')).toBe(false);
    expect(isWritableInMode('TEXT', 'update')).toBe(true);
  });
});
