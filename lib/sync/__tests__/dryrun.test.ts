import { describe, it, expect } from 'vitest';
import { planConnectionDryRun, type DryRunConnection } from '../dryrun';
import type { CustomFieldCatalog, CustomFieldDef, GhlFieldOption } from '../../ghl/types';
import type { RecordFields } from '../../ghl/records';

const stageOpts: GhlFieldOption[] = [
  { key: 'mvp', label: 'MVP' },
  { key: 'revenue', label: 'Revenue' },
];

function cat(fields: CustomFieldDef[]): CustomFieldCatalog {
  const byKey: Record<string, CustomFieldDef> = {};
  const byId: Record<string, CustomFieldDef> = {};
  for (const f of fields) { byKey[f.fieldKey] = f; byId[f.id] = f; }
  return { fields, folders: [], byKey, byId };
}
const oppCatalog = cat([
  { id: 's', name: 'Stage', fieldKey: 'opportunity.stage', dataType: 'SINGLE_OPTIONS', options: stageOpts },
  { id: 'n', name: 'Name', fieldKey: 'name', dataType: 'TEXT' },
]);

function rec(objectKey: string, id: string, values: Record<string, unknown>): RecordFields {
  return { objectKey, recordId: id, values, get: (k) => values[k] };
}

// Fixtures: source company co1; opportunities op1 (differs) + op2 (matches).
const records: Record<string, RecordFields> = {
  'business:co1': rec('business', 'co1', { 'business.stage': 'revenue', name: 'Acme' }),
  'opportunity:op1': rec('opportunity', 'op1', { 'opportunity.stage': 'mvp', name: 'Acme' }),
  'opportunity:op2': rec('opportunity', 'op2', { 'opportunity.stage': 'revenue', name: 'Acme' }),
};

const deps = {
  readRecordFields: async (objectKey: string, id: string) => records[`${objectKey}:${id}`],
  resolveCounterpartIds: async () => ['op1', 'op2'],
  getCatalog: async () => oppCatalog,
};

const connection: DryRunConnection = {
  sourceObject: 'business',
  targetObject: 'opportunity',
  associationId: 'company_opportunity',
  rows: [
    { sourceKey: 'business.stage', targetKey: 'opportunity.stage', direction: 'both' },
    { sourceKey: 'name', targetKey: 'name', direction: 'up' },
  ],
};

describe('planConnectionDryRun', () => {
  it('fans out to all associated counterparts and diffs each', async () => {
    const r = await planConnectionDryRun(connection, 'co1', deps as any);
    expect(r.counterpartCount).toBe(2);
    const op1 = r.counterparts.find((c) => c.targetId === 'op1')!;
    const op2 = r.counterparts.find((c) => c.targetId === 'op2')!;
    // op1: stage differs (mvp -> Revenue), name unchanged
    expect(op1.changes).toEqual([{ sourceKey: 'business.stage', targetKey: 'opportunity.stage', from: 'mvp', to: 'Revenue' }]);
    expect(op1.unchanged).toBe(1);
    // op2: both already match -> no changes
    expect(op2.changes).toHaveLength(0);
    expect(op2.unchanged).toBe(2);
  });

  it('option equality is key-aware (label vs stored key are equal)', async () => {
    const r = await planConnectionDryRun(connection, 'co1', deps as any);
    const op2 = r.counterparts.find((c) => c.targetId === 'op2')!;
    expect(op2.changes.some((c) => c.targetKey === 'opportunity.stage')).toBe(false);
  });

  it('is a no-op plan on the second run (idempotent-by-plan) once values match', async () => {
    // Simulate op1 already updated to revenue: re-plan sees no change.
    const updated = { ...deps, readRecordFields: async (o: string, id: string) =>
      id === 'op1' ? rec('opportunity', 'op1', { 'opportunity.stage': 'revenue', name: 'Acme' }) : records[`${o}:${id}`] };
    const r = await planConnectionDryRun(connection, 'co1', updated as any);
    expect(r.counterparts.every((c) => c.changes.length === 0)).toBe(true);
  });

  it('notes when there are no associated records', async () => {
    const empty = { ...deps, resolveCounterpartIds: async () => [] };
    const r = await planConnectionDryRun(connection, 'co1', empty as any);
    expect(r.counterpartCount).toBe(0);
    expect(r.note).toMatch(/no linked/);
  });

  it('notes when the connection has no source→target rows', async () => {
    const downOnly: DryRunConnection = { ...connection, rows: [{ sourceKey: 'x', targetKey: 'y', direction: 'down' }] };
    const r = await planConnectionDryRun(downOnly, 'co1', deps as any);
    expect(r.note).toMatch(/no source/);
  });
});
