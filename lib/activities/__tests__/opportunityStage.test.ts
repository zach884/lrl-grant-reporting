// The opportunity-stage adapter. The cases that matter are the two the live data forced:
// several stages implying ONE enrollment, and honest dating when the exact moment is unrecoverable.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../routes', () => ({ resolveRoute: vi.fn() }));
vi.mock('../upsert', async (orig) => ({
  ...(await orig<any>()),
  upsertActivity: vi.fn(async () => ({ recordId: 'act1', outcome: 'created', written: ['activity_date'], skipped: [] })),
}));

import { resolveRoute } from '../routes';
import { upsertActivity } from '../upsert';
import { ingestOpportunity, enrollmentKey, OPPORTUNITY_SOURCE, type GhlOpportunity } from '../sources/opportunityStage';

const mockRoute = resolveRoute as unknown as ReturnType<typeof vi.fn>;
const mockUpsert = upsertActivity as unknown as ReturnType<typeof vi.fn>;

const opp = (over: Partial<GhlOpportunity> = {}): GhlOpportunity => ({
  id: 'opp1',
  name: 'Lawrence Pryor',
  pipelineId: 'pipe-local',
  pipelineStageId: 'stage-selected',
  contactId: 'c1',
  status: 'open',
  createdAt: '2026-03-09T13:32:22.100Z',
  lastStageChangeAt: '2026-05-22T21:45:20.420Z',
  ...over,
});

const CONTACTS: Record<string, any> = {
  c1: { id: 'c1', firstName: 'Lawrence', lastName: 'Pryor', businessId: 'biz1' },
  'c-nolink': { id: 'c-nolink', firstName: 'No', lastName: 'Company' },
};

/** Option keys are lowercased by GHL; the record name should show the LABEL. */
const PROGRAM_OPTIONS = [
  { key: 'local', label: 'LOCAL' },
  { key: 'sama', label: 'SAMA' },
  { key: 'gateway', label: 'Gateway' },
];

const client: any = {
  locationId: 'LOC',
  async request({ path }: any) {
    const m = path.match(/^\/contacts\/(.+)$/);
    if (m) {
      const c = CONTACTS[m[1]];
      if (!c) throw new Error('not found');
      return { contact: c };
    }
    if (path === '/custom-fields/object-key/custom_objects.activities') {
      return {
        fields: [{ id: 'pg', name: 'Program / Grant Association', fieldKey: 'custom_objects.activities.program__grant_association', dataType: 'MULTIPLE_OPTIONS', options: PROGRAM_OPTIONS }],
        folders: [],
      };
    }
    throw new Error(`unexpected ${path}`);
  },
};

const ACCEPTED = { source: OPPORTUNITY_SOURCE, matchKind: 'pipeline_stage', matchId: 'stage-selected', matchLabel: 'LOCAL · Selected for Bootcamp', activityType: 'program_acceptance', program: ['local'], enabled: true };
const DOWNSTREAM = { ...ACCEPTED, matchId: 'stage-completed', matchLabel: 'LOCAL · Bootcamp Completed', defaults: { impliesAcceptance: true } };

beforeEach(async () => {
  mockRoute.mockReset();
  mockUpsert.mockClear();
  mockRoute.mockResolvedValue(ACCEPTED);
  const { getCatalog } = await import('../../ghl/catalogCache');
  await getCatalog('custom_objects.activities', { client, force: true });
});

describe('enrollmentKey', () => {
  it('is per opportunity + PROGRAM, not per stage — so several stages converge on one enrollment', () => {
    expect(enrollmentKey('opp1', ['local'], 'program_acceptance')).toBe('opp1:local');
    expect(enrollmentKey('opp1', ['local'], 'program_acceptance')).toBe(enrollmentKey('opp1', ['local'], 'program_acceptance'));
  });

  it('is order-insensitive across programs', () => {
    expect(enrollmentKey('opp1', ['sama', 'local'], 'x')).toBe(enrollmentKey('opp1', ['local', 'sama'], 'x'));
  });

  it('falls back to the activity type when there is no program — the grant case', () => {
    expect(enrollmentKey('opp9', undefined, 'grant')).toBe('opp9:grant');
  });
});

describe('ingestOpportunity', () => {
  it('creates a program-acceptance activity for the accepted stage', async () => {
    const r = await ingestOpportunity(opp(), { client });
    expect(r.status).toBe('ingested');
    const [key, input] = mockUpsert.mock.calls[0];
    expect(key).toEqual({ source: OPPORTUNITY_SOURCE, sourceRecordId: 'opp1:local' });
    expect(input.type).toBe('program_acceptance');
    expect(input.companyId).toBe('biz1');
    expect(input.values.program__grant_association).toEqual(['local']);
    // The record name shows the LABEL, not the lowercase option key.
    expect(input.values.activity_name).toBe('LOCAL acceptance – Lawrence Pryor');
  });

  it('never lets a later stage push the enrollment date forward', async () => {
    await ingestOpportunity(opp(), { client });
    // Set-once: the fields that say WHEN the enrollment began are written at create only.
    expect(mockUpsert.mock.calls[0][2].onlyIfAbsent).toContain('activity_date');
  });

  it('uses the stage-change moment as the acceptance date on the live path', async () => {
    await ingestOpportunity(opp(), { client });
    expect(mockUpsert.mock.calls[0][1].values.activity_date).toBe('2026-05-22T21:45:20.420Z');
    expect(mockUpsert.mock.calls[0][1].values.activity_notes).toBeUndefined();
  });

  it('gives ONE enrollment when several stages imply acceptance', async () => {
    await ingestOpportunity(opp(), { client });
    mockRoute.mockResolvedValue(DOWNSTREAM);
    await ingestOpportunity(opp({ pipelineStageId: 'stage-completed' }), { client });
    const keys = mockUpsert.mock.calls.map((c: any[]) => c[0].sourceRecordId);
    expect(keys).toEqual(['opp1:local', 'opp1:local']); // same key => upsert makes the 2nd a noop
  });

  it('dates a backfilled downstream stage from creation, and SAYS it is approximate', async () => {
    mockRoute.mockResolvedValue(DOWNSTREAM);
    const r = await ingestOpportunity(opp({ pipelineStageId: 'stage-completed' }), { client, backfill: true });
    expect(r.approximateDate).toBe(true);
    const values = mockUpsert.mock.calls[0][1].values;
    // The last stage change is some LATER move, not the acceptance — creation date is the honest floor.
    expect(values.activity_date).toBe('2026-03-09T13:32:22.100Z');
    expect(values.activity_notes).toMatch(/inferred|approximate/i);
  });

  it('keeps the exact date when the routed stage is the CURRENT one, even in a backfill', async () => {
    const r = await ingestOpportunity(opp(), { client, backfill: true });
    expect(r.approximateDate).toBe(false);
    expect(mockUpsert.mock.calls[0][1].values.activity_date).toBe('2026-05-22T21:45:20.420Z');
  });

  it('never leaks the impliesAcceptance config flag onto the record', async () => {
    mockRoute.mockResolvedValue(DOWNSTREAM);
    await ingestOpportunity(opp({ pipelineStageId: 'stage-completed' }), { client, backfill: true });
    expect(mockUpsert.mock.calls[0][1].values).not.toHaveProperty('impliesAcceptance');
  });

  it('writes grant lifecycle onto the grant activity, keyed on the opportunity', async () => {
    // The opportunity IS the grant, so the pipeline updates the record the form fills in —
    // one record, not a second one.
    mockRoute.mockResolvedValue({
      source: OPPORTUNITY_SOURCE, matchKind: 'pipeline_stage', matchId: 'stage-receipts',
      matchLabel: 'Direct Grant · Receipts Received', activityType: 'grant', enabled: true,
      defaults: { grant_status: 'Receipts Received' },
    });
    await ingestOpportunity(opp({ pipelineStageId: 'stage-receipts' }), { client });
    const [key, input] = mockUpsert.mock.calls[0];
    expect(key.sourceRecordId).toBe('opp1:grant');
    expect(input.type).toBe('grant');
    expect(input.values.grant_status).toBe('Receipts Received');
  });

  it('ingests nothing for an unrouted stage', async () => {
    mockRoute.mockResolvedValue(null);
    const r = await ingestOpportunity(opp({ pipelineStageId: 'stage-closed-lost' }), { client });
    expect(r).toMatchObject({ status: 'skipped', reason: 'no-route' });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('refuses to guess a company', async () => {
    const r = await ingestOpportunity(opp({ contactId: 'c-nolink' }), { client });
    expect(r).toMatchObject({ status: 'skipped', reason: 'no-company' });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('plans without writing on a dry run', async () => {
    const r = await ingestOpportunity(opp(), { client, dryRun: true });
    expect(r.status).toBe('ingested');
    expect(r.detail).toMatch(/would enroll/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
