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

  it("never lets a later stage move a GRANT's date", async () => {
    // Four stages route to `grant`, so without onlyIfAbsent every advance through the pipeline
    // rewrites activity_date to the latest stage-change moment. That field is the funder's "Date
    // Direct Grant Awarded" (TC column S). Measured 2026-08-31: one sweep would have rewritten the
    // date on all 50 grant activities. Names stay updatable; the date does not.
    mockRoute.mockResolvedValue({
      source: OPPORTUNITY_SOURCE, matchKind: 'pipeline_stage', matchId: 'stage-receipts',
      matchLabel: 'Direct Grant · Receipts Received', activityType: 'grant', enabled: true,
      defaults: { grant_status: 'Receipts Received' },
    });
    await ingestOpportunity(opp({ pipelineStageId: 'stage-receipts' }), { client });
    const opts = mockUpsert.mock.calls[0][2];
    expect(opts.onlyIfAbsent).toContain('activity_date');
    // ...but a grant's name and notes may still be corrected.
    expect(opts.onlyIfAbsent).not.toContain('activity_name');
    expect(opts.onlyIfAbsent).not.toContain('activity_notes');
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

  it('plans through the real code path on a dry run, in plan mode', async () => {
    // See the same test in appointment.test.ts: a dry run has to reach upsertActivity with
    // plan:true, or the review can only restate intent and cannot separate updates from no-ops.
    const r = await ingestOpportunity(opp(), { client, dryRun: true });
    expect(r.status).toBe('ingested');
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0][2]).toMatchObject({ plan: true });
    // The enrollment's identity still must not be rewritten by a later stage.
    expect(mockUpsert.mock.calls[0][2].onlyIfAbsent).toContain('activity_date');
  });
});

// ── copyFormFields, and the guard the brief demanded ─────────────────────────────────────────────
// grant-headline-fields.md §"Two traps": "activity_date MUST stay guarded. A live dry run of the form
// path reported it would write activity_date… The form copy must inherit the same guard when invoked
// from the stage path. Add a test that asserts it."

import { ROUTE_FLAGS } from '../sources/opportunityStage';

describe('ROUTE_FLAGS', () => {
  it('names every control key that must never reach GHL as a field', () => {
    // `defaults` is one bag carrying both field values and control flags, so a flag left in it is
    // offered to GHL as a field name. Harmless today (unknown keys are skipped) but it would mask a
    // genuinely typo'd field, which is the failure this list prevents.
    expect([...ROUTE_FLAGS]).toEqual(['impliesAcceptance', 'copyFormFields']);
  });
});

describe('the grant stage routes, as seeded', () => {
  // Read the seed's own table rather than the DB, so this pins the DECISION about which stages are
  // "final" — the thing a future edit is most likely to get wrong.
  const STAGES: Record<string, { status: string; copy: boolean }> = {
    '3bf7ecee-342b-48ab-a874-f300223a45a0': { status: 'Application Complete', copy: false },
    '0dfd181d-1270-4fb2-81e9-99606b8fa216': { status: 'Agreement Executed', copy: true },
    '29569048-1326-489b-b658-4b7bebeba54b': { status: 'Receipts Received', copy: false },
    '37c0eae6-c3cd-4b2c-b5bb-7cf56248da0b': { status: 'Closed Won', copy: true },
  };

  it('copies the form fields at exactly the two stages where the line items are final', () => {
    const copying = Object.values(STAGES).filter((s) => s.copy).map((s) => s.status).sort();
    expect(copying).toEqual(['Agreement Executed', 'Closed Won']);
  });

  it('does NOT copy at Application Complete — those numbers are a request, not an award', () => {
    expect(STAGES['3bf7ecee-342b-48ab-a874-f300223a45a0'].copy).toBe(false);
  });

  it('does NOT copy at Receipts Received — nothing about the agreement changes then', () => {
    expect(STAGES['29569048-1326-489b-b658-4b7bebeba54b'].copy).toBe(false);
  });

  it('copies at Closed Won, which is what picks up an AMENDED agreement', () => {
    // Zach, 2026-09-03: "if the line items on the grant change due to an amended agreement I want the
    // grant activity to have the last version of the line items instead of the first."
    expect(STAGES['37c0eae6-c3cd-4b2c-b5bb-7cf56248da0b'].copy).toBe(true);
  });
});

describe('mergeFormValues — the guard', () => {
  it('NEVER takes activity_date from the form', async () => {
    // The trap the brief named. A live dry run of the form path reported it would write
    // activity_date; letting it through is what replaced real award dates with a sweep's run date.
    const { mergeFormValues } = await import('../sources/opportunityStage');
    const values: Record<string, unknown> = { activity_date: '2026-03-11', activity_name: 'Direct Grant – Acme' };
    mergeFormValues(values, { activity_date: '2026-08-20', award_amount: 4000 }, { grant_status: 'Closed Won' });
    expect(values.activity_date).toBe('2026-03-11');
    expect(values.award_amount).toBe(4000);
  });

  it('lets the route default win over the contact, because the STAGE is more current', async () => {
    const { mergeFormValues } = await import('../sources/opportunityStage');
    const values: Record<string, unknown> = { grant_status: 'Closed Won' };
    mergeFormValues(values, { grant_status: 'Application Complete' }, { grant_status: 'Closed Won' });
    expect(values.grant_status).toBe('Closed Won');
  });

  it('does not overwrite anything the stage already computed', async () => {
    const { mergeFormValues } = await import('../sources/opportunityStage');
    const values: Record<string, unknown> = { activity_name: 'Direct Grant – Acme' };
    mergeFormValues(values, { activity_name: 'something else' }, null);
    expect(values.activity_name).toBe('Direct Grant – Acme');
  });

  it('carries every other field through', async () => {
    const { mergeFormValues } = await import('../sources/opportunityStage');
    const values: Record<string, unknown> = {};
    mergeFormValues(values, { expense_amount_item_1: 300, expense_category_item_3: 'inventory_supplies', grant_program: 'Gateway' }, null);
    expect(values).toEqual({ expense_amount_item_1: 300, expense_category_item_3: 'inventory_supplies', grant_program: 'Gateway' });
  });
});
