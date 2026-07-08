import { describe, it, expect } from 'vitest';
import { suggestMappings } from '../suggest';
import { resolveMappings, collectIssues } from '../resolve';
import type { CustomFieldCatalog, CustomFieldDef } from '../../ghl/types';
import type { FieldMapping } from '../types';

function catalog(fields: CustomFieldDef[]): CustomFieldCatalog {
  const byKey: Record<string, CustomFieldDef> = {};
  const byId: Record<string, CustomFieldDef> = {};
  for (const f of fields) {
    byKey[f.fieldKey] = f;
    byId[f.id] = f;
  }
  return { fields, folders: [], byKey, byId };
}

const contactCat = catalog([
  { id: 'c1', name: 'NAICS Code', fieldKey: 'contact.naics_code', dataType: 'TEXT' },
  { id: 'c2', name: 'County', fieldKey: 'contact.county_mi__full', dataType: 'SINGLE_OPTIONS' },
  { id: 'c3', name: 'Annual Revenue', fieldKey: 'contact.annual_revenue', dataType: 'NUMERICAL' },
  { id: 'c4', name: 'Interested Programs', fieldKey: 'contact.interested_programs', dataType: 'CHECKBOX' },
]);

const businessCat = catalog([
  { id: 'b1', name: 'NAICS Code', fieldKey: 'business.naics_code', dataType: 'NUMERICAL' },
  { id: 'b2', name: 'County', fieldKey: 'business.county', dataType: 'SINGLE_OPTIONS',
    options: [{ key: 'jackson_county_mi', label: 'Jackson County (MI)' }] },
  { id: 'b3', name: 'Annual Revenue', fieldKey: 'business.annual_revenue', dataType: 'NUMERICAL' },
  { id: 'b4', name: 'I Am Selling', fieldKey: 'business.i_am_selling', dataType: 'MULTIPLE_OPTIONS' },
]);

describe('suggestMappings', () => {
  it('always proposes the companyName<->name legacy pair as mirror-down', () => {
    const s = suggestMappings(contactCat, businessCat);
    const cn = s.find((m) => m.businessKey === 'name');
    expect(cn).toMatchObject({ contactKey: 'companyName', direction: 'down', mirrorDown: true });
  });

  it('pairs fields with the same bare key', () => {
    const s = suggestMappings(contactCat, businessCat);
    expect(s.find((m) => m.businessKey === 'business.naics_code')?.contactKey).toBe('contact.naics_code');
    expect(s.find((m) => m.businessKey === 'business.county')?.contactKey).toBe('contact.county_mi__full')
      // county bare keys differ, so this is a NAME match, not a key match
      ;
  });

  it('never targets a company field twice', () => {
    const s = suggestMappings(contactCat, businessCat);
    const targets = s.map((m) => m.businessKey);
    expect(new Set(targets).size).toBe(targets.length);
  });
});

describe('resolveMappings + collectIssues', () => {
  it('flags an unwritable company target as an error', () => {
    const maps: FieldMapping[] = [
      { contactKey: 'contact.interested_programs', businessKey: 'business.i_am_selling', direction: 'both', mirrorDown: false },
    ];
    const resolved = resolveMappings(maps, contactCat, businessCat);
    expect(resolved[0].businessWritable).toBe(false);
    expect(resolved[0].issues.some((i) => i.level === 'error')).toBe(true);
  });

  it('flags a mapping to a non-existent field', () => {
    const maps: FieldMapping[] = [
      { contactKey: 'contact.ghost', businessKey: 'business.ghost', direction: 'both', mirrorDown: false },
    ];
    const resolved = resolveMappings(maps, contactCat, businessCat);
    expect(resolved[0].contactExists).toBe(false);
    expect(resolved[0].businessExists).toBe(false);
    expect(resolved[0].issues.filter((i) => i.level === 'error').length).toBe(2);
  });

  it('marks option<->option pairs as optionType and treats scalars as present/writable', () => {
    const maps: FieldMapping[] = [
      { contactKey: 'contact.county_mi__full', businessKey: 'business.county', direction: 'both', mirrorDown: true },
      { contactKey: 'companyName', businessKey: 'name', direction: 'down', mirrorDown: true },
    ];
    const resolved = resolveMappings(maps, contactCat, businessCat);
    expect(resolved[0].optionType).toBe(true);
    expect(resolved[1].contactExists).toBe(true);
    expect(resolved[1].businessExists).toBe(true);
    expect(resolved[1].businessWritable).toBe(true);
  });

  it('detects two mappings fighting over the same company field', () => {
    const maps: FieldMapping[] = [
      { contactKey: 'contact.naics_code', businessKey: 'business.naics_code', direction: 'both', mirrorDown: false },
      { contactKey: 'contact.annual_revenue', businessKey: 'business.naics_code', direction: 'both', mirrorDown: false },
    ];
    const issues = collectIssues(resolveMappings(maps, contactCat, businessCat));
    expect(issues.some((i) => i.message.includes('targeted by 2'))).toBe(true);
  });
});
