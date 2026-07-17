import { describe, it, expect } from 'vitest';
import { syncConnection } from '../apply';
import type { DryRunConnection } from '../dryrun';
import type { CustomFieldCatalog, CustomFieldDef } from '../../ghl/types';
import type { RecordFields } from '../../ghl/records';

function cat(fields: CustomFieldDef[]): CustomFieldCatalog {
  const byKey: Record<string, CustomFieldDef> = {}; const byId: Record<string, CustomFieldDef> = {};
  for (const f of fields) { byKey[f.fieldKey] = f; byId[f.id] = f; }
  return { fields, folders: [], byKey, byId };
}
const catalog = cat([{ id: 'n', name: 'Name', fieldKey: 'name', dataType: 'TEXT' }]);
function rec(objectKey: string, id: string, values: Record<string, unknown>): RecordFields {
  return { objectKey, recordId: id, values, get: (k) => values[k] };
}
const records: Record<string, RecordFields> = {
  'business:co1': rec('business', 'co1', { name: 'Cargility' }),
  'opportunity:op1': rec('opportunity', 'op1', { name: 'Old Name' }), // differs
  'opportunity:op2': rec('opportunity', 'op2', { name: 'Cargility' }), // matches
};

function makeDeps(ids: string[]) {
  const writes: Array<{ objectKey: string; id: string; changes: Record<string, unknown> }> = [];
  const deps = {
    readRecordFields: async (o: string, id: string) => records[`${o}:${id}`],
    resolveCounterpartIds: async () => ids,
    getCatalog: async () => catalog,
    writeRecordFields: async (objectKey: string, id: string, changes: Record<string, unknown>) => {
      writes.push({ objectKey, id, changes });
      return { written: Object.keys(changes), skipped: [] };
    },
  };
  return { deps, writes };
}

const pushConn: DryRunConnection = { sourceObject: 'business', targetObject: 'opportunity', associationId: 'x', rows: [{ sourceKey: 'name', targetKey: 'name', direction: 'up' }] };

describe('syncConnection (apply)', () => {
  it('writes only the changed counterpart, skips the matching one', async () => {
    const { deps, writes } = makeDeps(['op1', 'op2']);
    const r = await syncConnection(pushConn, 'co1', { apply: true }, deps as any);
    expect(r.counterpartCount).toBe(2);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ objectKey: 'opportunity', id: 'op1', changes: { name: 'Cargility' } });
    expect(r.forward.find((f) => f.targetId === 'op2')!.unchanged).toBe(1);
  });

  it('never writes a disabled row (enabled === false)', async () => {
    const conn: DryRunConnection = { ...pushConn, rows: [{ sourceKey: 'name', targetKey: 'name', direction: 'up', enabled: false }] };
    const { deps, writes } = makeDeps(['op1']); // op1 differs, but the row is disabled
    const r = await syncConnection(conn, 'co1', { apply: true }, deps as any);
    expect(writes).toHaveLength(0);
    expect(r.forward[0].changes).toHaveLength(0);
  });

  it('apply:false plans without writing', async () => {
    const { deps, writes } = makeDeps(['op1', 'op2']);
    const r = await syncConnection(pushConn, 'co1', { apply: false }, deps as any);
    expect(writes).toHaveLength(0);
    expect(r.forward.find((f) => f.targetId === 'op1')!.changes).toHaveLength(1);
  });

  it('is idempotent — a second run (target already matches) writes nothing', async () => {
    const matched: Record<string, RecordFields> = { ...records, 'opportunity:op1': rec('opportunity', 'op1', { name: 'Cargility' }) };
    const writes: any[] = [];
    const deps = {
      readRecordFields: async (o: string, id: string) => matched[`${o}:${id}`],
      resolveCounterpartIds: async () => ['op1'],
      getCatalog: async () => catalog,
      writeRecordFields: async (...a: any[]) => { writes.push(a); return { written: [], skipped: [] }; },
    };
    const r = await syncConnection(pushConn, 'co1', { apply: true }, deps as any);
    expect(writes).toHaveLength(0);
    expect(r.forward[0].changes).toHaveLength(0);
  });

  it('reverse (down) is skipped with a note when there are multiple counterparts', async () => {
    const conn: DryRunConnection = { ...pushConn, rows: [{ sourceKey: 'name', targetKey: 'name', direction: 'down' }] };
    const { deps } = makeDeps(['op1', 'op2']);
    const r = await syncConnection(conn, 'co1', { apply: true }, deps as any);
    expect(r.reverse?.note).toMatch(/2 counterparts/);
    expect(r.reverse?.written).toHaveLength(0);
  });

  it('reverse (down) writes to the source when there is exactly one counterpart', async () => {
    const conn: DryRunConnection = { ...pushConn, rows: [{ sourceKey: 'name', targetKey: 'name', direction: 'down' }] };
    const { deps, writes } = makeDeps(['op1']); // op1.name "Old Name" differs from source "Cargility"
    const r = await syncConnection(conn, 'co1', { apply: true }, deps as any);
    // reverse writes target's value onto the source (business co1)
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ objectKey: 'business', id: 'co1', changes: { name: 'Old Name' } });
    expect(r.reverse?.written).toContain('name');
  });

  describe('countryCode transform', () => {
    const countryCat = cat([{
      id: 'ctry', name: 'Country', fieldKey: 'business.country', dataType: 'SINGLE_OPTIONS',
      options: [{ key: 'us', label: 'United States' }, { key: 'ca', label: 'Canada' }],
    }]);
    const conn: DryRunConnection = {
      sourceObject: 'contact', targetObject: 'business', associationId: 'scalar:source:businessId',
      rows: [{ sourceKey: 'country', targetKey: 'business.country', direction: 'up', transform: 'countryCode' }],
    };
    // contact scalar "us" (lowercase); business option field empty -> should write "US" VERBATIM (not the label).
    function makeCountryDeps(businessCountry: unknown) {
      const writes: any[] = [];
      const recs: Record<string, RecordFields> = {
        'contact:ct1': rec('contact', 'ct1', { country: 'us' }),
        'business:co1': rec('business', 'co1', { 'business.country': businessCountry, country: businessCountry }),
      };
      const deps = {
        readRecordFields: async (o: string, id: string) => recs[`${o}:${id}`],
        resolveCounterpartIds: async () => ['co1'],
        getCatalog: async () => countryCat,
        writeRecordFields: async (objectKey: string, id: string, changes: Record<string, unknown>, _c: any, _cl: any, rawKeys: Set<string>) => {
          writes.push({ objectKey, id, changes, rawKeys: rawKeys ? Array.from(rawKeys) : [] });
          return { written: Object.keys(changes), skipped: [] };
        },
      };
      return { deps, writes };
    }

    it('writes the uppercased ISO code verbatim and flags it opaque (no option-label coercion)', async () => {
      const { deps, writes } = makeCountryDeps('');
      const r = await syncConnection(conn, 'ct1', { apply: true }, deps as any);
      expect(writes).toHaveLength(1);
      expect(writes[0].changes['business.country']).toBe('US');   // NOT "United States"
      expect(writes[0].rawKeys).toContain('country');             // opaque write
      expect(r.forward[0].changes[0]).toMatchObject({ fieldKey: 'business.country', to: 'US' });
    });

    it('does not churn when the target already holds the option key ("us")', async () => {
      const { deps, writes } = makeCountryDeps('us'); // stored option key vs source "us" -> "US", case-insensitive equal
      const r = await syncConnection(conn, 'ct1', { apply: true }, deps as any);
      expect(writes).toHaveLength(0);
      expect(r.forward[0].changes).toHaveLength(0);
      expect(r.forward[0].unchanged).toBe(1);
    });
  });
});
