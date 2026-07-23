import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture writes instead of hitting GHL.
vi.mock('../../ghl/writeRecord', () => ({ writeRecordFields: vi.fn(async () => ({ written: [], skipped: [] })) }));

import { writeRecordFields } from '../../ghl/writeRecord';
import { applyRecordProposals } from '../recordEngine';
import type { RecordEnrichmentProposal } from '../types';
import type { CustomFieldCatalog, CustomFieldDef } from '../../ghl/types';

const mockWrite = writeRecordFields as unknown as ReturnType<typeof vi.fn>;
const OBJ = 'custom_objects.resources';

function catalog(keys: string[]): CustomFieldCatalog {
  const defs: CustomFieldDef[] = keys.map((k, i) => ({ id: `id_${i}`, name: k, fieldKey: `${OBJ}.${k}`, dataType: 'MULTIPLE_OPTIONS' }));
  const byKey: Record<string, CustomFieldDef> = {}; const byId: Record<string, CustomFieldDef> = {};
  for (const d of defs) { byKey[d.fieldKey] = d; byId[d.id] = d; }
  return { fields: defs, folders: [], byKey, byId };
}
const prov = { source: 'anthropic', method: 'ai' as const, confidence: 0.9, timestamp: 't' };
function prop(k: string, value: unknown, confidence = 0.9): RecordEnrichmentProposal {
  return { fieldKey: `${OBJ}.${k}`, value, provenance: { ...prov, confidence } };
}

beforeEach(() => mockWrite.mockReset().mockResolvedValue({ written: [], skipped: [] }));

describe('applyRecordProposals', () => {
  const cat = catalog(['service_areas', 'mrl_stops']);

  it('writes changed fields in overwrite mode', async () => {
    const cur: Record<string, unknown> = { [`${OBJ}.service_areas`]: ['Old'] };
    const res = await applyRecordProposals(OBJ, 'r1', [prop('service_areas', ['New'])], cat, (k) => cur[k], { mode: 'overwrite' }, { apply: true, client: {} as any });
    expect(res.applied.map((a) => a.fieldKey)).toEqual([`${OBJ}.service_areas`]);
    expect(mockWrite).toHaveBeenCalledOnce();
  });

  it('skips a value that is already up to date (idempotent)', async () => {
    const cur: Record<string, unknown> = { [`${OBJ}.service_areas`]: ['Legal'] };
    const res = await applyRecordProposals(OBJ, 'r1', [prop('service_areas', ['legal'])], cat, (k) => cur[k], { mode: 'overwrite' }, { apply: true, client: {} as any });
    expect(res.applied).toEqual([]);
    expect(res.skipped[0].reason).toMatch(/up to date/);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('fill-empty skips a field that already has a value', async () => {
    const cur: Record<string, unknown> = { [`${OBJ}.service_areas`]: ['Legal'] };
    const res = await applyRecordProposals(OBJ, 'r1', [prop('service_areas', ['GTM'])], cat, (k) => cur[k], { mode: 'fill-empty' }, { apply: true });
    expect(res.applied).toEqual([]);
    expect(res.skipped[0].reason).toMatch(/fill-empty/);
  });

  it('drops proposals below min confidence + fields not in the catalog', async () => {
    const res = await applyRecordProposals(OBJ, 'r1', [prop('service_areas', ['X'], 0.2), prop('unknown_field', ['Y'])], cat, () => undefined, { mode: 'overwrite', minConfidence: 0.5 }, { apply: false });
    expect(res.applied).toEqual([]);
    const reasons = res.skipped.map((s) => s.reason).join(' ');
    expect(reasons).toMatch(/below min confidence/);
    expect(reasons).toMatch(/not in the object catalog|not in object catalog/);
  });

  it('dry-run does not write', async () => {
    const res = await applyRecordProposals(OBJ, 'r1', [prop('service_areas', ['New'])], cat, () => undefined, { mode: 'overwrite' }, { apply: false });
    expect(res.didWrite).toBe(false);
    expect(mockWrite).not.toHaveBeenCalled();
  });
});
