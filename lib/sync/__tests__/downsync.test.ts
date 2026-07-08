import { describe, it, expect } from 'vitest';
import {
  businessValueToContactInput,
  buildDesiredContactState,
  planContactWrites,
  valuesEqual,
} from '../downsync';
import type { CustomFieldCatalog, CustomFieldDef, BusinessRecord, Contact } from '../../ghl/types';
import type { FieldMapping } from '../../mapping/types';

function cat(fields: CustomFieldDef[]): CustomFieldCatalog {
  const byKey: Record<string, CustomFieldDef> = {};
  const byId: Record<string, CustomFieldDef> = {};
  for (const f of fields) { byKey[f.fieldKey] = f; byId[f.id] = f; }
  return { fields, folders: [], byKey, byId };
}

const businessCat = cat([
  { id: 'b_c', name: 'County', fieldKey: 'business.county', dataType: 'SINGLE_OPTIONS',
    options: [{ key: 'jackson_county_mi', label: 'Jackson County (MI)' }] },
  { id: 'b_w', name: 'Women Owned', fieldKey: 'business.women_owned', dataType: 'SINGLE_OPTIONS',
    options: [{ key: 'yes', label: 'Yes' }] },
  { id: 'b_s', name: 'Selling', fieldKey: 'business.i_am_selling', dataType: 'MULTIPLE_OPTIONS',
    options: [{ key: 'product', label: 'Product' }, { key: 'service', label: 'Service' }] },
]);

const contactCat = cat([
  { id: 'c_county', name: 'County', fieldKey: 'contact.county', dataType: 'SINGLE_OPTIONS',
    options: [{ key: 'jackson_county_mi', label: 'Jackson County (MI)' }] },
  { id: 'c_women', name: 'Women', fieldKey: 'contact.women', dataType: 'SINGLE_OPTIONS',
    options: [{ key: 'yes', label: 'Yes' }] },
  { id: 'c_selling', name: 'Selling', fieldKey: 'contact.selling', dataType: 'MULTIPLE_OPTIONS',
    options: [{ key: 'product', label: 'Product' }, { key: 'service', label: 'Service' }] },
]);

const mappings: FieldMapping[] = [
  { contactKey: 'companyName', businessKey: 'name', direction: 'down', mirrorDown: true },
  { contactKey: 'contact.county', businessKey: 'business.county', direction: 'both', mirrorDown: true },
  { contactKey: 'contact.women', businessKey: 'business.women_owned', direction: 'both', mirrorDown: true },
  { contactKey: 'contact.selling', businessKey: 'business.i_am_selling', direction: 'down', mirrorDown: false },
  // an 'up'-only mapping must be ignored by down-sync:
  { contactKey: 'contact.notes', businessKey: 'business.notes', direction: 'up', mirrorDown: false },
];

const company: BusinessRecord = {
  id: 'co1',
  properties: {
    name: 'Acme Robotics',
    county: 'jackson_county_mi', // stored as KEY on the company
    women_owned: 'yes',
    i_am_selling: ['product', 'service'],
    notes: 'should not sync down',
  },
};

describe('businessValueToContactInput', () => {
  it('single-select company KEY -> contact LABEL', () => {
    expect(businessValueToContactInput('business.county', 'jackson_county_mi', businessCat)).toBe('Jackson County (MI)');
  });
  it('multi-select company KEYS -> LABEL array', () => {
    expect(businessValueToContactInput('business.i_am_selling', ['product', 'service'], businessCat))
      .toEqual(['Product', 'Service']);
  });
  it('scalar/unknown passes through', () => {
    expect(businessValueToContactInput('name', 'Acme Robotics', businessCat)).toBe('Acme Robotics');
  });
});

describe('buildDesiredContactState', () => {
  it('includes only down/both mappings, converts values, maps companyName scalar', () => {
    const d = buildDesiredContactState(company, mappings, businessCat);
    expect(d.companyName).toBe('Acme Robotics');
    expect(d.customInputs).toEqual({
      'contact.county': 'Jackson County (MI)',
      'contact.women': 'Yes',
      'contact.selling': ['Product', 'Service'],
    });
    expect(d.customInputs['contact.notes']).toBeUndefined(); // up-only excluded
  });
});

describe('planContactWrites (equality guard)', () => {
  it('writes only changed fields; leaves matching ones alone', () => {
    const desired = buildDesiredContactState(company, mappings, businessCat);
    const contact: Contact = {
      id: 'ct1',
      companyName: 'Stale Name',
      customFields: [
        { id: 'c_county', value: 'Jackson County (MI)' }, // already correct -> unchanged
        { id: 'c_women', value: 'No' }, // differs -> write
        // c_selling missing -> write
      ],
    };
    const plan = planContactWrites(desired, contact, contactCat);
    const ids = plan.changedFields.map((f) => f.id).sort();
    expect(ids).toEqual(['c_selling', 'c_women']);
    expect(plan.unchanged).toBe(1);
    expect(plan.companyName).toBe('Acme Robotics');
  });

  it('writes nothing when everything already matches (idempotent)', () => {
    const desired = buildDesiredContactState(company, mappings, businessCat);
    const contact: Contact = {
      id: 'ct2',
      companyName: 'Acme Robotics',
      customFields: [
        { id: 'c_county', value: 'Jackson County (MI)' },
        { id: 'c_women', value: 'Yes' },
        { id: 'c_selling', value: ['Service', 'Product'] }, // different order -> still equal
      ],
    };
    const plan = planContactWrites(desired, contact, contactCat);
    expect(plan.changedFields).toEqual([]);
    expect(plan.companyName).toBeUndefined();
    expect(plan.unchanged).toBe(3);
  });
});

describe('valuesEqual', () => {
  it('array order-insensitive', () => {
    expect(valuesEqual(['a', 'b'], ['b', 'a'])).toBe(true);
  });
  it('number/string tolerant', () => {
    expect(valuesEqual(12, '12')).toBe(true);
  });
  it('null/empty equal', () => {
    expect(valuesEqual(null, '')).toBe(true);
  });
  it('distinguishes real differences', () => {
    expect(valuesEqual(['a'], ['a', 'b'])).toBe(false);
  });
});
