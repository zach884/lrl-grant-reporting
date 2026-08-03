import { describe, it, expect } from 'vitest';
import { countyRawToLabel } from '../enrichers/county';
import type { GhlFieldOption } from '../../ghl/types';

const OPTIONS: GhlFieldOption[] = [
  { key: 'jackson', label: 'Jackson County (MI)' },
  { key: 'washtenaw', label: 'Washtenaw County (MI)' },
  { key: 'other', label: 'Other' },
];

describe('countyRawToLabel', () => {
  it('maps a MI county to the "(MI)" option for both "MI" and spelled-out "Michigan"', () => {
    expect(countyRawToLabel('Jackson County', 'MI', OPTIONS)).toBe('Jackson County (MI)');
    expect(countyRawToLabel('Jackson County', 'Michigan', OPTIONS)).toBe('Jackson County (MI)'); // the bug fix
    expect(countyRawToLabel('Jackson County', 'michigan', OPTIONS)).toBe('Jackson County (MI)');
  });
  it('tolerates a "County" suffix or its absence', () => {
    expect(countyRawToLabel('Washtenaw', 'MI', OPTIONS)).toBe('Washtenaw County (MI)');
  });
  it('forces "Other" only for a state that is present and clearly not Michigan', () => {
    expect(countyRawToLabel('Cook County', 'IL', OPTIONS)).toBe('Other');
  });
  it('falls through to the county match when the state is blank (geocoded county is authoritative)', () => {
    expect(countyRawToLabel('Jackson County', undefined, OPTIONS)).toBe('Jackson County (MI)');
  });
  it('returns null when there is no county', () => {
    expect(countyRawToLabel('', 'MI', OPTIONS)).toBeNull();
  });
});
