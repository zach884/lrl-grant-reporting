import { describe, it, expect } from 'vitest';
import { readContactValue, buildDesiredCompanyState, planCompanyWrites } from '../upsync';
import type { CustomFieldCatalog, CustomFieldDef, BusinessRecord, Contact } from '../../ghl/types';
import type { FieldMapping } from '../../mapping/types';

function cat(fields: CustomFieldDef[]): CustomFieldCatalog {
  const byKey: Record<string, CustomFieldDef> = {};
  const byId: Record<string, CustomFieldDef> = {};
  for (const f of fields) { byKey[f.fieldKey] = f; byId[f.id] = f; }
  return { fields, folders: [], byKey, byId };
}

const businessCat = cat([
  { id: 'b_naics', name: 'NAICS', fieldKey: 'business.naics_code', dataType: 'NUMERICAL' },
  { id: 'b_county', name: 'County', fieldKey: 'business.county', dataType: 'SINGLE_OPTIONS',
    options: [{ key: 'jackson_county_mi', label: 'Jackson County (MI)' }, { key: 'other', label: 'Other' }] },
  { id: 'b_inc', name: 'Inc Date', fieldKey: 'business.date_of_incorporation', dataType: 'DATE' },
  { id: 'b_sell', name: 'Selling', fieldKey: 'business.i_am_selling', dataType: 'MULTIPLE_OPTIONS' }, // create-only -> skip
]);

const contactCat = cat([
  { id: 'c_naics', name: 'NAICS', fieldKey: 'contact.naics_code', dataType: 'NUMERICAL' },
  { id: 'c_county', name: 'County', fieldKey: 'contact.county_mi__full', dataType: 'SINGLE_OPTIONS',
    options: [{ key: 'jackson_county_mi', label: 'Jackson County (MI)' }, { key: 'other', label: 'Other' }] },
  { id: 'c_inc', name: 'Inc Date', fieldKey: 'contact.date_of_incorporation', dataType: 'DATE' },
  { id: 'c_sell', name: 'Selling', fieldKey: 'contact.i_am_selling', dataType: 'MULTIPLE_OPTIONS' },
]);

const mappings: FieldMapping[] = [
  { contactKey: 'contact.naics_code', businessKey: 'business.naics_code', direction: 'both', mirrorDown: false },
  { contactKey: 'contact.county_mi__full', businessKey: 'business.county', direction: 'both', mirrorDown: true },
  { contactKey: 'contact.date_of_incorporation', businessKey: 'business.date_of_incorporation', direction: 'up', mirrorDown: false },
  { contactKey: 'contact.i_am_selling', businessKey: 'business.i_am_selling', direction: 'both', mirrorDown: false }, // up-considered but create-only -> skipped
  { contactKey: 'companyName', businessKey: 'name', direction: 'down', mirrorDown: true }, // down-only -> excluded from up
];

const contact: Contact = {
  id: 'ct1',
  businessId: 'co1',
  customFields: [
    { id: 'c_naics', value: 541511 },
    { id: 'c_county', value: 'Jackson County (MI)' }, // contact stores label
    { id: 'c_inc', value: '2026-07-07' },
    { id: 'c_sell', value: ['Product'] },
  ],
};

describe('readContactValue', () => {
  it('reads a custom field by catalog id', () => {
    expect(readContactValue('contact.naics_code', contact, contactCat)).toBe(541511);
  });
  it('reads a scalar (companyName)', () => {
    expect(readContactValue('companyName', { ...contact, companyName: 'Acme' } as Contact, contactCat)).toBe('Acme');
  });
});

describe('buildDesiredCompanyState', () => {
  it('includes up/both, excludes down-only and create-only + name', () => {
    const d = buildDesiredCompanyState(contact, mappings, contactCat, businessCat);
    expect(d.inputs).toEqual({
      naics_code: 541511,
      county: 'Jackson County (MI)',
      date_of_incorporation: '2026-07-07',
    });
    // i_am_selling (down + create-only) and name (down) excluded
    expect(d.inputs['i_am_selling']).toBeUndefined();
    expect(d.skipped.some((s) => s.reason.includes('create-only'))).toBe(true);
  });
});

describe('planCompanyWrites (field-aware equality guard)', () => {
  it('writes only genuinely-changed fields (single-select key vs label, date form)', () => {
    const desired = buildDesiredCompanyState(contact, mappings, contactCat, businessCat);
    const company: BusinessRecord = {
      id: 'co1',
      properties: {
        naics_code: 541511,             // same -> unchanged
        county: 'jackson_county_mi',    // company stores KEY == contact label -> unchanged
        date_of_incorporation: '2026-07-07', // company stores date-only == coerced ISO -> unchanged
      },
    };
    const plan = planCompanyWrites(desired, company, businessCat);
    expect(plan.changed).toEqual({});
    expect(plan.unchanged).toBe(3);
  });

  it('detects a real change and coerces the write value', () => {
    const desired = buildDesiredCompanyState(contact, mappings, contactCat, businessCat);
    const company: BusinessRecord = {
      id: 'co1',
      properties: { naics_code: 111111, county: 'other', date_of_incorporation: '2026-07-07' },
    };
    const plan = planCompanyWrites(desired, company, businessCat);
    // naics changed (111111 -> 541511); county changed (other -> Jackson); date same
    expect(plan.changed.naics_code).toBe(541511);
    expect(plan.changed.county).toBe('Jackson County (MI)'); // sent as LABEL
    expect(plan.changed.date_of_incorporation).toBeUndefined();
  });
});
