import { describe, it, expect } from 'vitest';
import {
  businessValueToContactInput,
  buildDesiredContactState,
  planContactWrites,
  valuesEqual,
  scalarEqual,
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

describe('no-downgrade guard (holdValues)', () => {
  const bCat = cat([
    { id: 'b_c', name: 'County', fieldKey: 'business.county', dataType: 'SINGLE_OPTIONS',
      options: [{ key: 'jackson_county_mi', label: 'Jackson County (MI)' }, { key: 'other', label: 'Other' }] },
  ]);
  const cCat = cat([
    { id: 'c_county', name: 'County', fieldKey: 'contact.county_mi__full', dataType: 'SINGLE_OPTIONS',
      options: [{ key: 'jackson_county_mi', label: 'Jackson County (MI)' }, { key: 'other', label: 'Other' }] },
  ]);
  const map: FieldMapping[] = [
    { contactKey: 'contact.county_mi__full', businessKey: 'business.county', direction: 'both', mirrorDown: true, holdValues: ['Other'] },
  ];
  const coOther: BusinessRecord = { id: 'co', properties: { county: 'other' } };

  it('does NOT overwrite a known contact county with company "Other"', () => {
    const desired = buildDesiredContactState(coOther, map, bCat);
    const contact: Contact = { id: 'ct', customFields: [{ id: 'c_county', value: 'Jackson County (MI)' }] };
    const plan = planContactWrites(desired, contact, cCat);
    expect(plan.changedFields).toEqual([]);
    expect(plan.skipped.some((s) => s.reason.startsWith('no-downgrade'))).toBe(true);
  });

  it('DOES fill an empty contact county with "Other"', () => {
    const desired = buildDesiredContactState(coOther, map, bCat);
    const contact: Contact = { id: 'ct', customFields: [] };
    const plan = planContactWrites(desired, contact, cCat);
    expect(plan.changedFields).toHaveLength(1);
    expect(String(plan.changedFields[0].value)).toContain('Other');
  });
});

describe('standard contact scalars (address block + website)', () => {
  const bCat = cat([
    { id: 'b_addr', name: 'Address', fieldKey: 'business.address', dataType: 'TEXT' },
    { id: 'b_city', name: 'City', fieldKey: 'business.city', dataType: 'TEXT' },
    { id: 'b_zip', name: 'Postal Code', fieldKey: 'business.postalcode', dataType: 'TEXT' },
    { id: 'b_web', name: 'Website', fieldKey: 'business.website', dataType: 'TEXT' },
  ]);
  const cCat = cat([]); // scalars are NOT custom fields
  const map: FieldMapping[] = [
    { contactKey: 'address1', businessKey: 'business.address', direction: 'both', mirrorDown: true },
    { contactKey: 'city', businessKey: 'business.city', direction: 'both', mirrorDown: true },
    { contactKey: 'postalCode', businessKey: 'business.postalcode', direction: 'both', mirrorDown: true },
    { contactKey: 'website', businessKey: 'business.website', direction: 'both', mirrorDown: true },
  ];
  const co: BusinessRecord = {
    id: 'co',
    properties: { address: '123 Rocket Rd', city: 'Jackson', postalcode: '49201', website: 'https://lrl.org' },
  };

  it('routes standard scalars to scalarInputs (NOT customInputs)', () => {
    const d = buildDesiredContactState(co, map, bCat);
    expect(d.customInputs).toEqual({});
    expect(d.scalarInputs).toEqual({
      address1: '123 Rocket Rd',
      city: 'Jackson',
      postalCode: '49201',
      website: 'https://lrl.org',
    });
  });

  it('plans scalar writes for differing/empty values, case-insensitively idempotent', () => {
    const d = buildDesiredContactState(co, map, bCat);
    const contact: Contact = {
      id: 'ct',
      address1: '123 Rocket Rd',        // exact match -> unchanged
      city: 'jackson',                  // case differs -> unchanged (case-insensitive)
      postalCode: '00000',              // differs -> write
      // website missing -> write
    };
    const plan = planContactWrites(d, contact, cCat);
    expect(Object.keys(plan.changedScalars).sort()).toEqual(['postalCode', 'website']);
    expect(plan.changedScalars['postalCode']).toBe('49201');
    expect(plan.changedScalars['website']).toBe('https://lrl.org');
    expect(plan.unchanged).toBe(2);
  });

  it('writes nothing when all scalars already match (idempotent)', () => {
    const d = buildDesiredContactState(co, map, bCat);
    const contact: Contact = {
      id: 'ct', address1: '123 Rocket Rd', city: 'Jackson', postalCode: '49201', website: 'https://lrl.org',
    };
    const plan = planContactWrites(d, contact, cCat);
    expect(plan.changedScalars).toEqual({});
    expect(plan.unchanged).toBe(4);
  });
});

describe('country transform down-sync', () => {
  const bCat = cat([
    { id: 'b_country', name: 'Country', fieldKey: 'business.country', dataType: 'SINGLE_OPTIONS',
      options: [{ key: 'us', label: 'United States' }] },
  ]);
  const cCat = cat([]);
  const map: FieldMapping[] = [
    { contactKey: 'country', businessKey: 'business.country', direction: 'both', mirrorDown: true, transform: 'countryCode' },
  ];

  it('down-syncs company "us" as uppercased scalar "US" (not the label)', () => {
    const co: BusinessRecord = { id: 'co', properties: { country: 'us' } };
    const d = buildDesiredContactState(co, map, bCat);
    expect(d.scalarInputs).toEqual({ country: 'US' });
    // contact already "US" -> no write (case-insensitive)
    const plan = planContactWrites(d, { id: 'ct', country: 'US' } as Contact, cCat);
    expect(plan.changedScalars).toEqual({});
  });
});

describe('scalarEqual', () => {
  it('case- and whitespace-insensitive', () => {
    expect(scalarEqual('US', 'us')).toBe(true);
    expect(scalarEqual(' Jackson ', 'jackson')).toBe(true);
    expect(scalarEqual(null, '')).toBe(true);
    expect(scalarEqual('49201', '49202')).toBe(false);
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
