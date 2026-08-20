// The form adapter: contact fields → a Grant or Metrics activity.
// The interesting parts are identity (one snapshot per client per period; one record per grant) and
// refusing to guess.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../routes', () => ({ resolveRoute: vi.fn() }));
vi.mock('../upsert', async (orig) => ({
  ...(await orig<any>()),
  upsertActivity: vi.fn(async () => ({ recordId: 'act1', outcome: 'created', written: ['activity_date'], skipped: [] })),
}));

import { resolveRoute } from '../routes';
import { upsertActivity } from '../upsert';
import { ingestFormSubmission, mapContactValuesToActivity, FORM_SOURCE } from '../sources/form';
import { ACTIVITIES_OBJECT } from '../schema';

const mockRoute = resolveRoute as unknown as ReturnType<typeof vi.fn>;
const mockUpsert = upsertActivity as unknown as ReturnType<typeof vi.fn>;

const METRICS_FORM = 'ed03BbRGWrc6Ugtwr9JB';
const GRANT_FORM = '0d8irJ6Ay6VQFajG06Go';
const DIRECT_GRANTS = 'trGMRtrlkvUG1UtMbuMJ';

const ACT_FIELDS = [
  { id: 'at', name: 'Activity Type', fieldKey: `${ACTIVITIES_OBJECT}.activity_type`, dataType: 'SINGLE_OPTIONS', parentId: 'core', options: [{ key: 'metrics', label: 'Metrics' }, { key: 'grant', label: 'Grant' }] },
  { id: 'an', name: 'Activity Name', fieldKey: `${ACTIVITIES_OBJECT}.activity_name`, dataType: 'TEXT', parentId: 'core' },
  { id: 'ad', name: 'Activity Date', fieldKey: `${ACTIVITIES_OBJECT}.activity_date`, dataType: 'DATE', parentId: 'core' },
  { id: 'no', name: 'Notes', fieldKey: `${ACTIVITIES_OBJECT}.activity_notes`, dataType: 'LARGE_TEXT', parentId: 'core' },
  { id: 'rp', name: 'Reporting Period', fieldKey: `${ACTIVITIES_OBJECT}.reporting_period`, dataType: 'DATE', parentId: 'met' },
  { id: 'jc', name: 'Jobs created', fieldKey: `${ACTIVITIES_OBJECT}.jobs_created_in_the_last_6_months`, dataType: 'NUMERICAL', parentId: 'met' },
  { id: 'ga', name: 'Total Grant Amount', fieldKey: `${ACTIVITIES_OBJECT}.score_total_grant_amount`, dataType: 'NUMERICAL', parentId: 'grt' },
];
const ACT_FOLDERS = [
  { id: 'core', name: 'Activity Info' },
  { id: 'met', name: 'Metrics' },
  { id: 'grt', name: 'Grant' },
];
const CONTACT_FIELDS = [
  { id: 'c-jc', name: 'Jobs created', fieldKey: 'contact.jobs_created_in_the_last_6_months', dataType: 'NUMERICAL' },
  { id: 'c-ga', name: 'Total Grant Amount', fieldKey: 'contact.score_total_grant_amount', dataType: 'NUMERICAL' },
  { id: 'c-un', name: 'Something else', fieldKey: 'contact.unrelated_field', dataType: 'TEXT' },
];

const CONTACT = {
  id: 'c1', firstName: 'Derya', lastName: 'K', businessId: 'biz1',
  customFields: [
    { id: 'c-jc', value: 3 },
    { id: 'c-ga', value: 10000 },
    { id: 'c-un', value: 'ignore me' },
  ],
};

function makeClient(opts: { opportunities?: any[]; contact?: any } = {}) {
  const contact = opts.contact === undefined ? CONTACT : opts.contact;
  return {
    locationId: 'LOC',
    async request({ path }: any) {
      if (path.startsWith('/contacts/')) {
        if (!contact) throw new Error('not found');
        return { contact };
      }
      if (path === `/custom-fields/object-key/${ACTIVITIES_OBJECT}`) return { fields: ACT_FIELDS, folders: ACT_FOLDERS };
      if (path.includes('/customFields')) return { customFields: CONTACT_FIELDS };
      if (path === '/opportunities/search') return { opportunities: opts.opportunities ?? [] };
      throw new Error(`unexpected ${path}`);
    },
  } as any;
}

beforeEach(async () => {
  mockRoute.mockReset();
  mockUpsert.mockClear();
  const { getCatalog } = await import('../../ghl/catalogCache');
  await getCatalog(ACTIVITIES_OBJECT, { client: makeClient(), force: true });
  await getCatalog('contact', { client: makeClient(), force: true });
});

describe('mapContactValuesToActivity', () => {
  it('copies only fields the activity type actually has, matched by key', () => {
    const byId = Object.fromEntries(CONTACT_FIELDS.map((f) => [f.id, f]));
    const out = mapContactValuesToActivity(CONTACT, byId as any, new Set(['jobs_created_in_the_last_6_months']));
    expect(out).toEqual({ jobs_created_in_the_last_6_months: 3 });
    expect(out).not.toHaveProperty('unrelated_field');
  });

  it('skips empty values rather than blanking the activity', () => {
    const byId = Object.fromEntries(CONTACT_FIELDS.map((f) => [f.id, f]));
    const out = mapContactValuesToActivity(
      { customFields: [{ id: 'c-jc', value: '' }, { id: 'c-ga', value: null }] },
      byId as any,
      new Set(['jobs_created_in_the_last_6_months', 'score_total_grant_amount']),
    );
    expect(out).toEqual({});
  });
});

describe('ingestFormSubmission — metrics', () => {
  beforeEach(() => {
    mockRoute.mockResolvedValue({ source: FORM_SOURCE, matchKind: 'form', matchId: METRICS_FORM, matchLabel: 'Client Reporting Form', activityType: 'metrics', enabled: true });
  });

  it('keys ONE snapshot per client per reporting period', async () => {
    const client = makeClient();
    const r = await ingestFormSubmission({ contactId: 'c1', formId: METRICS_FORM }, { client, submittedAt: '2026-09-12' });
    expect(r.status).toBe('ingested');
    expect(r.reportingPeriod).toBe('2026-08-31');
    expect(mockUpsert.mock.calls[0][0]).toEqual({ source: FORM_SOURCE, sourceRecordId: 'c1:2026-08-31' });
  });

  it('derives the period from the submission date, not from the client', async () => {
    const client = makeClient();
    await ingestFormSubmission({ contactId: 'c1', formId: METRICS_FORM }, { client, submittedAt: '2026-03-10' });
    const values = mockUpsert.mock.calls[0][1].values;
    expect(values.reporting_period).toBe('2026-02-28');
    expect(values.activity_name).toBe('Metrics – Sep 2025–Feb 2026');
  });

  it('gives a resubmission the SAME key, so it corrects rather than duplicates', async () => {
    const client = makeClient();
    await ingestFormSubmission({ contactId: 'c1', formId: METRICS_FORM }, { client, submittedAt: '2026-09-12' });
    await ingestFormSubmission({ contactId: 'c1', formId: METRICS_FORM }, { client, submittedAt: '2026-10-02' });
    const keys = mockUpsert.mock.calls.map((c: any[]) => c[0].sourceRecordId);
    expect(keys[0]).toBe(keys[1]);
  });

  it('gives the NEXT period a different key', async () => {
    const client = makeClient();
    await ingestFormSubmission({ contactId: 'c1', formId: METRICS_FORM }, { client, submittedAt: '2026-03-10' });
    await ingestFormSubmission({ contactId: 'c1', formId: METRICS_FORM }, { client, submittedAt: '2026-09-12' });
    const keys = mockUpsert.mock.calls.map((c: any[]) => c[0].sourceRecordId);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe('ingestFormSubmission — grant', () => {
  beforeEach(() => {
    mockRoute.mockResolvedValue({
      source: FORM_SOURCE, matchKind: 'form', matchId: GRANT_FORM, matchLabel: 'Direct Grant Application',
      activityType: 'grant', enabled: true, defaults: { pipelineId: DIRECT_GRANTS },
    });
  });

  it('keys on the OPPORTUNITY — id AND source — so it merges with the pipeline\'s grant record', async () => {
    const client = makeClient({ opportunities: [{ id: 'opp7', updatedAt: '2026-08-01' }] });
    await ingestFormSubmission({ contactId: 'c1', formId: GRANT_FORM }, { client });
    // Identity is (source, source_record_id). Matching only the id finds nothing, because the
    // pipeline wrote the record under its own source — that would duplicate every grant.
    expect(mockUpsert.mock.calls[0][0]).toEqual({ source: 'Opportunity Stage', sourceRecordId: 'opp7:grant' });
  });

  it('falls back to the FORM source when there is no opportunity to key on', async () => {
    const client = makeClient({ opportunities: [] });
    await ingestFormSubmission({ contactId: 'c1', formId: GRANT_FORM }, { client, submittedAt: '2026-08-19' });
    expect(mockUpsert.mock.calls[0][0]).toEqual({ source: 'Form', sourceRecordId: 'c1:2026-08-19' });
  });

  it('prefers the most recently touched opportunity when a client has several', async () => {
    const client = makeClient({ opportunities: [
      { id: 'old', updatedAt: '2025-01-01' },
      { id: 'current', updatedAt: '2026-08-01' },
    ] });
    await ingestFormSubmission({ contactId: 'c1', formId: GRANT_FORM }, { client });
    expect(mockUpsert.mock.calls[0][0].sourceRecordId).toBe('current:grant');
  });

  it('does not invent a second grant when no opportunity matches — it flags instead', async () => {
    const client = makeClient({ opportunities: [] });
    await ingestFormSubmission({ contactId: 'c1', formId: GRANT_FORM }, { client, submittedAt: '2026-08-19' });
    const [key, input] = mockUpsert.mock.calls[0];
    expect(key.sourceRecordId).toBe('c1:2026-08-19');
    expect(String(input.values.activity_notes)).toMatch(/no matching .*opportunity/i);
  });
});

describe('ingestFormSubmission — refusals', () => {
  it('ingests nothing for an unrouted form', async () => {
    mockRoute.mockResolvedValue(null);
    const r = await ingestFormSubmission({ contactId: 'c1', formId: 'unknown-form' }, { client: makeClient() });
    expect(r).toMatchObject({ status: 'skipped', reason: 'no-route' });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('refuses to guess a company', async () => {
    mockRoute.mockResolvedValue({ source: FORM_SOURCE, matchKind: 'form', matchId: METRICS_FORM, activityType: 'metrics', enabled: true });
    const client = makeClient({ contact: { id: 'c9', customFields: [] } });
    const r = await ingestFormSubmission({ contactId: 'c9', formId: METRICS_FORM }, { client });
    expect(r).toMatchObject({ status: 'skipped', reason: 'no-company' });
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
