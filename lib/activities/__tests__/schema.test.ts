// The type registry: folder-driven field sets + the completeness policy.
// Field/folder shapes here mirror the LIVE catalog dumped 2026-08-19 (see the sprint spec).

import { describe, it, expect } from 'vitest';
import {
  ACTIVITIES_OBJECT,
  ACTIVITY_TYPES,
  activityFieldSet,
  activityType,
  bareKey,
  defaultActivityName,
  staffLoggedTypes,
  validateActivityInput,
} from '../schema';
import type { CustomFieldCatalog, CustomFieldDef } from '../../ghl/types';

const F = { core: 'f-core', ta: 'f-ta', ref: 'f-ref', event: 'f-event', grant: 'f-grant' };

function field(key: string, folder: string, dataType: CustomFieldDef['dataType'] = 'TEXT', extra: Partial<CustomFieldDef> = {}): CustomFieldDef {
  return { id: key, name: key.replace(/_/g, ' '), fieldKey: `${ACTIVITIES_OBJECT}.${key}`, dataType, parentId: folder, ...extra };
}

const fields: CustomFieldDef[] = [
  field('activity_type', F.core, 'SINGLE_OPTIONS', { position: 0 }),
  field('activity_name', F.core, 'TEXT', { position: 1 }),
  field('activity_date', F.core, 'DATE', { position: 2 }),
  field('activity_owner', F.core, 'TEXT', { position: 3 }),
  field('activity_notes', F.core, 'LARGE_TEXT', { position: 4 }),
  field('program__grant_association', F.core, 'MULTIPLE_OPTIONS', { position: 5 }),
  field('referral_type', F.core, 'MULTIPLE_OPTIONS', { position: 6 }),
  field('appointment_id', F.core, 'TEXT', { position: 7 }),
  field('activity_source', F.core, 'SINGLE_OPTIONS', { position: 8 }),
  field('source_record_id', F.core, 'TEXT', { position: 9 }),
  field('modality', F.ta, 'SINGLE_OPTIONS'),
  field('service_topic', F.ta, 'SINGLE_OPTIONS'),
  field('counterparty_name', F.ref, 'TEXT'),
  field('referral_reason', F.ref, 'LARGE_TEXT'),
  field('event_name', F.event, 'TEXT', { position: 1 }),
  field('event_type', F.event, 'SINGLE_OPTIONS', { position: 2 }),
  field('registered', F.event, 'SINGLE_OPTIONS', { position: 3 }),
  field('attended', F.event, 'SINGLE_OPTIONS', { position: 4 }),
  field('event_id', F.event, 'TEXT', { position: 5 }),
  field('grant_program', F.grant, 'SINGLE_OPTIONS'),
  field('award_amount', F.grant, 'NUMERICAL'),
];

const catalog: CustomFieldCatalog = {
  fields,
  folders: [
    { id: F.core, name: 'Activity Info' },
    { id: F.ta, name: 'Technical Assistance' },
    { id: F.ref, name: 'Referral' },
    { id: F.event, name: 'Event' },
    { id: F.grant, name: 'Grant' },
  ],
  byKey: Object.fromEntries(fields.map((f) => [f.fieldKey, f])),
  byId: Object.fromEntries(fields.map((f) => [f.id, f])),
};

const keys = (defs: CustomFieldDef[]) => defs.map(bareKey);

describe('activity type registry', () => {
  it('covers exactly the live activity_type option keys', () => {
    // Seven since 2026-08-19: program_acceptance was added to the live picklist for phase 4.
    expect(ACTIVITY_TYPES.map((t) => t.key)).toEqual([
      'intake', 'technical_assistance', 'introduction_referral', 'workshop_event', 'grant', 'metrics',
      'program_acceptance',
    ]);
  });

  it('treats grant, metrics and program acceptance as machine-fed, not staff-logged', () => {
    expect(staffLoggedTypes().map((t) => t.key)).toEqual([
      'intake', 'technical_assistance', 'introduction_referral', 'workshop_event',
    ]);
    expect(activityType('grant')!.staffLogged).toBe(false);
    expect(activityType('metrics')!.staffLogged).toBe(false);
    // Enrollment comes from a pipeline stage — a person never types it.
    expect(activityType('program_acceptance')!.staffLogged).toBe(false);
  });
});

describe('activityFieldSet', () => {
  it('excludes the discriminator and the two mis-foldered core fields', () => {
    const set = activityFieldSet(catalog, 'intake');
    expect(keys(set.core)).toEqual(['activity_name', 'activity_date', 'activity_owner', 'activity_notes', 'program__grant_association']);
    expect(keys(set.core)).not.toContain('activity_type');
    // referral_type lives in Activity Info but belongs to referrals; appointment_id is the Zoom hook.
    expect(keys(set.core)).not.toContain('referral_type');
    expect(keys(set.core)).not.toContain('appointment_id');
    // The idempotency key is machine-owned — a typo in it would let the next delivery duplicate.
    expect(keys(set.core)).not.toContain('activity_source');
    expect(keys(set.core)).not.toContain('source_record_id');
  });

  it('reads a type\'s fields from its folder', () => {
    expect(keys(activityFieldSet(catalog, 'technical_assistance').typeFields)).toEqual(['modality', 'service_topic']);
    expect(keys(activityFieldSet(catalog, 'grant').typeFields)).toEqual(['grant_program', 'award_amount']);
  });

  it('pulls referral_type in as a Referral field even though its folder says core', () => {
    const set = activityFieldSet(catalog, 'introduction_referral');
    expect(keys(set.typeFields)).toEqual(['referral_type', 'counterparty_name', 'referral_reason']);
  });

  it('orders prominent fields first and reports them', () => {
    const set = activityFieldSet(catalog, 'workshop_event');
    expect(keys(set.typeFields)).toEqual(['event_name', 'event_type', 'registered', 'attended', 'event_id']);
    expect(keys(set.prominent)).toEqual(['event_name', 'event_type', 'registered', 'attended']);
  });

  it('gives intake core fields only', () => {
    expect(activityFieldSet(catalog, 'intake').typeFields).toEqual([]);
  });

  it('returns core with no required fields for an unknown type', () => {
    const set = activityFieldSet(catalog, 'nope');
    expect(set.typeFields).toEqual([]);
    expect(set.required).toEqual([]);
    expect(set.core.length).toBeGreaterThan(0);
  });

  it('picks up a field added to a folder with no code change', () => {
    const extended: CustomFieldCatalog = {
      ...catalog,
      fields: [...fields, field('session_length_minutes', F.ta, 'NUMERICAL', { position: 9 })],
    };
    expect(keys(activityFieldSet(extended, 'technical_assistance').typeFields)).toContain('session_length_minutes');
  });
});

describe('validateActivityInput', () => {
  const base = { type: 'technical_assistance', companyId: 'biz1', values: { activity_date: '2026-08-19', modality: 'one_on_one', service_topic: 'coaching' } };

  it('accepts a complete input', () => {
    expect(validateActivityInput(base, catalog)).toEqual([]);
  });

  it('refuses an activity with no company — it would be invisible to reporting', () => {
    const errs = validateActivityInput({ ...base, companyId: '' }, catalog);
    expect(errs.some((e) => /companyId is required/.test(e))).toBe(true);
  });

  it('requires a date', () => {
    const errs = validateActivityInput({ ...base, values: { modality: 'group', service_topic: 'finance' } }, catalog);
    expect(errs.some((e) => /activity_date is required/.test(e))).toBe(true);
  });

  it('names each missing type-required field', () => {
    const errs = validateActivityInput({ ...base, values: { activity_date: '2026-08-19' } }, catalog);
    expect(errs.some((e) => /modality/.test(e))).toBe(true);
    expect(errs.some((e) => /service_topic/.test(e))).toBe(true);
  });

  it('treats an empty array as missing', () => {
    const errs = validateActivityInput(
      { type: 'introduction_referral', companyId: 'biz1', values: { activity_date: '2026-08-19', referral_type: [], counterparty_name: 'Acme' } },
      catalog,
    );
    expect(errs.some((e) => /referral_type/.test(e))).toBe(true);
  });

  it('rejects an unknown type without cascading other errors', () => {
    expect(validateActivityInput({ type: 'coaching', companyId: 'biz1', values: {} }, catalog)).toEqual([
      expect.stringContaining('unknown activity_type "coaching"'),
    ]);
  });

  it('rejects staff entry of a form-fed type', () => {
    const errs = validateActivityInput({ type: 'grant', companyId: 'biz1', values: { activity_date: '2026-08-19' } }, catalog);
    expect(errs.some((e) => /come from a GHL form/.test(e))).toBe(true);
  });

  it('rejects a referred-to contact on a non-referral', () => {
    const errs = validateActivityInput({ ...base, referredToContactId: 'c9' }, catalog);
    expect(errs.some((e) => /only applies to an Introduction/.test(e))).toBe(true);
  });
});

describe('defaultActivityName', () => {
  it('is "<Type> – <Company> – <YYYY-MM-DD>"', () => {
    expect(defaultActivityName('technical_assistance', 'Acme Corp', '2026-08-19T00:00:00.000Z'))
      .toBe('Technical Assistance – Acme Corp – 2026-08-19');
  });

  it('omits missing parts rather than leaving empty separators', () => {
    expect(defaultActivityName('intake', '', '2026-08-19')).toBe('Intake – 2026-08-19');
  });
});
