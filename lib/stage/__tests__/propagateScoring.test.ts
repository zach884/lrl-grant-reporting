import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the sync engine + connection loader so we test only propagateScoring's wiring.
vi.mock('../../sync/orchestrate', () => ({ loadPushConnection: vi.fn() }));
vi.mock('../../sync/apply', () => ({ syncConnection: vi.fn() }));

import { loadPushConnection } from '../../sync/orchestrate';
import { syncConnection } from '../../sync/apply';
import { propagateCurrentScoring, CURRENT_SCORING_SLUG } from '../propagateScoring';

const mockLoad = loadPushConnection as unknown as ReturnType<typeof vi.fn>;
const mockSync = syncConnection as unknown as ReturnType<typeof vi.fn>;

const conn = (enabled: boolean | undefined = true) => ({
  name: CURRENT_SCORING_SLUG,
  sourceObject: 'custom_objects.business_stage',
  targetObject: 'business',
  associationId: 'assoc1',
  rows: [{ sourceKey: 'custom_objects.business_stage.trl', targetKey: 'business.trl_current', direction: 'up', enabled }],
});

const applyResult = (over: Partial<any> = {}) => ({
  sourceObject: 'custom_objects.business_stage', targetObject: 'business', sourceRecordId: 'rec1',
  counterpartCount: 1, applied: true, reverse: null,
  forward: [{ targetId: 'co1', changes: [{ fieldKey: 'business.trl_current', from: null, to: 5 }], unchanged: 0, written: ['business.trl_current'], skipped: [] }],
  ...over,
});

beforeEach(() => { mockLoad.mockReset(); mockSync.mockReset(); });

describe('propagateCurrentScoring', () => {
  it('returns not-configured (and never calls the engine) when the connection is missing', async () => {
    mockLoad.mockResolvedValue(null);
    const r = await propagateCurrentScoring('rec1', { apply: true });
    expect(r.ran).toBe(false);
    expect(r.reason).toContain(CURRENT_SCORING_SLUG);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('skips when all mappings are disabled', async () => {
    mockLoad.mockResolvedValue(conn(false));
    const r = await propagateCurrentScoring('rec1', { apply: true });
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/no enabled/);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('applies and reports the written company fields', async () => {
    mockLoad.mockResolvedValue(conn());
    mockSync.mockResolvedValue(applyResult());
    const r = await propagateCurrentScoring('rec1', { apply: true });
    expect(mockSync).toHaveBeenCalledWith(conn(), 'rec1', { apply: true }, undefined, undefined);
    expect(r).toMatchObject({ ran: true, companyId: 'co1', changed: ['business.trl_current'] });
  });

  it('dry-run reports the would-change fields from the diff, not written', async () => {
    mockLoad.mockResolvedValue(conn());
    mockSync.mockResolvedValue(applyResult({
      applied: false,
      forward: [{ targetId: 'co1', changes: [{ fieldKey: 'business.mrl_current', from: 2, to: 4 }], unchanged: 0, written: [], skipped: [] }],
    }));
    const r = await propagateCurrentScoring('rec1', { apply: false });
    expect(r).toMatchObject({ ran: true, companyId: 'co1', changed: ['business.mrl_current'] });
  });

  it('reports no linked company when the source record has no counterpart', async () => {
    mockLoad.mockResolvedValue(conn());
    mockSync.mockResolvedValue(applyResult({ counterpartCount: 0, forward: [], note: 'no linked records on the target side' }));
    const r = await propagateCurrentScoring('rec1', { apply: true });
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/no linked/);
  });
});
