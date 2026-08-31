// Idempotency — the prerequisite for every ingestion adapter.
// A duplicate delivery must converge to `noop`, because duplicate activities double-count in reports.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../audit/log', () => ({ logChange: vi.fn(async () => {}) }));

import { logChange } from '../../audit/log';
import { upsertActivity, findActivityBySource, SOURCE_FIELD, SOURCE_ID_FIELD } from '../upsert';
import { GhlApiError } from '../../ghl/errors';
import { clearAssociationCache } from '../../ghl/associations';
import { ACTIVITIES_OBJECT } from '../schema';
import type { CustomFieldDef } from '../../ghl/types';

const mockLog = logChange as unknown as ReturnType<typeof vi.fn>;

const defs: CustomFieldDef[] = [
  { id: 'at', name: 'Activity Type', fieldKey: `${ACTIVITIES_OBJECT}.activity_type`, dataType: 'SINGLE_OPTIONS', parentId: 'core',
    options: [{ key: 'technical_assistance', label: 'Technical Assistance' }, { key: 'metrics', label: 'Metrics' }] },
  { id: 'an', name: 'Activity Name', fieldKey: `${ACTIVITIES_OBJECT}.activity_name`, dataType: 'TEXT', parentId: 'core' },
  { id: 'ad', name: 'Activity Date', fieldKey: `${ACTIVITIES_OBJECT}.activity_date`, dataType: 'DATE', parentId: 'core' },
  { id: 'ao', name: 'Activity Owner', fieldKey: `${ACTIVITIES_OBJECT}.activity_owner`, dataType: 'TEXT', parentId: 'core' },
  { id: 'no', name: 'Activity Notes', fieldKey: `${ACTIVITIES_OBJECT}.activity_notes`, dataType: 'LARGE_TEXT', parentId: 'core' },
  { id: 'as', name: '[SYNC] Activity Source', fieldKey: `${ACTIVITIES_OBJECT}.${SOURCE_FIELD}`, dataType: 'SINGLE_OPTIONS', parentId: 'core',
    options: [{ key: 'appointment', label: 'Appointment' }, { key: 'form', label: 'Form' }, { key: 'manual', label: 'Manual' }] },
  { id: 'sr', name: '[SYNC] Source Record ID', fieldKey: `${ACTIVITIES_OBJECT}.${SOURCE_ID_FIELD}`, dataType: 'TEXT', parentId: 'core' },
  { id: 'md', name: 'Modality', fieldKey: `${ACTIVITIES_OBJECT}.modality`, dataType: 'SINGLE_OPTIONS', parentId: 'ta',
    options: [{ key: 'one_on_one', label: '1:1' }, { key: 'group', label: 'Group' }] },
  { id: 'st', name: 'Service Topic', fieldKey: `${ACTIVITIES_OBJECT}.service_topic`, dataType: 'SINGLE_OPTIONS', parentId: 'ta',
    options: [{ key: 'coaching', label: 'Coaching' }, { key: 'finance', label: 'Finance' }] },
];

const FOLDERS = [
  { id: 'core', name: 'Activity Info' },
  { id: 'ta', name: 'Technical Assistance' },
];

const ASSOC_DEFS = [
  { id: 'assoc-company', key: 'company_activity', firstObjectKey: 'business', secondObjectKey: ACTIVITIES_OBJECT },
  { id: 'assoc-contact', key: 'activity_contact', firstObjectKey: 'contact', secondObjectKey: ACTIVITIES_OBJECT },
];

/**
 * GHL stores a SINGLE_OPTIONS value as its option KEY even though the write sends the LABEL. The
 * fake reproduces that, because a fake that echoes what it was given hid a real bug: the source
 * lookup filtered on 'Manual' while live GHL had stored 'manual', so it never found the existing
 * record and every re-delivery would have created a duplicate.
 */
function store(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    const def = defs.find((d) => d.fieldKey === `${ACTIVITIES_OBJECT}.${k}`);
    const hit = def?.dataType === 'SINGLE_OPTIONS' ? def.options?.find((o) => o.label === v || o.key === v) : undefined;
    out[k] = hit ? hit.key : v;
  }
  return out;
}

/** A fake location holding activity records, with the search endpoint's property filter. */
function fakeClient() {
  const records = new Map<string, Record<string, unknown>>();
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  let seq = 0;
  const client: any = {
    requests,
    records,
    locationId: 'LOC',
    async request({ method = 'GET', path, body }: any) {
      requests.push({ method, path, body });
      if (method === 'POST' && path === `/objects/${ACTIVITIES_OBJECT}/records/search`) {
        const filters: any[] = body.filters ?? [];
        const hits = Array.from(records.entries())
          .filter(([, props]) => filters.every((f) => props[String(f.field).replace('properties.', '')] === f.value))
          .map(([id, properties]) => ({ id, properties }));
        return { records: hits, total: hits.length };
      }
      if (method === 'POST' && path === `/objects/${ACTIVITIES_OBJECT}/records`) {
        const id = `act${++seq}`;
        records.set(id, store(body.properties));
        return { record: { id, properties: records.get(id) } };
      }
      if (method === 'PUT' && path.startsWith(`/objects/${ACTIVITIES_OBJECT}/records/`)) {
        const id = path.split('/').pop()!;
        Object.assign(records.get(id)!, store(body.properties));
        return { record: { id, properties: records.get(id) } };
      }
      if (method === 'GET' && path.startsWith(`/objects/${ACTIVITIES_OBJECT}/records/`)) {
        const id = path.split('/').pop()!;
        return { record: { id, properties: records.get(id) ?? {} } };
      }
      if (method === 'GET' && path === '/objects/business/records/biz1') {
        return { record: { id: 'biz1', objectKey: 'business', properties: { name: 'Acme Corp' } } };
      }
      if (method === 'GET' && path === `/custom-fields/object-key/${ACTIVITIES_OBJECT}`) return { fields: defs, folders: FOLDERS };
      if (method === 'GET' && path === '/associations/') return { associations: ASSOC_DEFS };
      if (method === 'POST' && path === '/associations/relations') return { relation: { id: 'rel' } };
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return client;
}

const key = { source: 'Appointment' as const, sourceRecordId: 'appt-123' };
const input = {
  type: 'technical_assistance',
  companyId: 'biz1',
  contactIds: ['c1'],
  values: { activity_date: '2026-08-19', activity_notes: 'Pricing review' },
};

beforeEach(async () => {
  mockLog.mockClear();
  clearAssociationCache();
  const { getCatalog } = await import('../../ghl/catalogCache');
  await getCatalog(ACTIVITIES_OBJECT, { client: fakeClient(), force: true });
});

describe('upsertActivity', () => {
  it('creates the record on first delivery, stamped with its source key', async () => {
    const client = fakeClient();
    const res = await upsertActivity(key, input, { client });

    expect(res.outcome).toBe('created');
    const stored = client.records.get(res.recordId);
    expect(stored[SOURCE_ID_FIELD]).toBe('appt-123');
    expect(stored[SOURCE_FIELD]).toBe('appointment'); // stored as the KEY, as GHL does
  });

  it('is a NOOP on re-delivery of the same event — no duplicate record', async () => {
    const client = fakeClient();
    const first = await upsertActivity(key, input, { client });
    mockLog.mockClear();
    const second = await upsertActivity(key, input, { client });

    expect(second.outcome).toBe('noop');
    expect(second.recordId).toBe(first.recordId);
    expect(client.records.size).toBe(1);
    expect(second.written).toEqual([]);
    // Nothing changed, so nothing is logged — a noop must not fill the change log with churn.
    expect(mockLog).not.toHaveBeenCalled();
  });

  it('updates in place when the source event changed', async () => {
    const client = fakeClient();
    const first = await upsertActivity(key, input, { client });
    const res = await upsertActivity(key, { ...input, values: { ...input.values, activity_notes: 'Pricing review + follow-up' } }, { client });

    expect(res.outcome).toBe('updated');
    expect(res.recordId).toBe(first.recordId);
    expect(client.records.size).toBe(1);
    expect(client.records.get(res.recordId).activity_notes).toBe('Pricing review + follow-up');
  });

  it('logs an update against the adapter, not a person', async () => {
    const client = fakeClient();
    await upsertActivity(key, input, { client });
    mockLog.mockClear();
    await upsertActivity(key, { ...input, values: { ...input.values, activity_notes: 'changed' } }, { client });

    const ev = mockLog.mock.calls[0][0];
    expect(ev).toMatchObject({ actorKind: 'sync', actorName: 'activity:appointment', action: 'update' });
    expect(ev.changes[0]).toMatchObject({ field: `${ACTIVITIES_OBJECT}.activity_notes`, from: 'Pricing review', to: 'changed' });
  });

  it('attributes a created record to the adapter too', async () => {
    const client = fakeClient();
    await upsertActivity(key, input, { client });
    expect(mockLog.mock.calls[0][0]).toMatchObject({ actorKind: 'sync', actorName: 'activity:appointment', action: 'create' });
  });

  it('keeps events from different sources apart even if their ids collide', async () => {
    const client = fakeClient();
    await upsertActivity(key, input, { client });
    const other = await upsertActivity({ source: 'Form', sourceRecordId: 'appt-123' }, input, { client });

    expect(other.outcome).toBe('created');
    expect(client.records.size).toBe(2);
  });

  it('ingests a form-fed type that manual entry would refuse', async () => {
    const client = fakeClient();
    const res = await upsertActivity(
      { source: 'Form', sourceRecordId: 'sub-9' },
      { type: 'metrics', companyId: 'biz1', values: { activity_date: '2026-08-19' } },
      { client },
    );
    expect(res.outcome).toBe('created');
  });

  it('still refuses an ingested activity with no company', async () => {
    const client = fakeClient();
    await expect(
      upsertActivity(key, { ...input, companyId: '' }, { client }),
    ).rejects.toThrow(/companyId is required/);
  });

  it('does not re-link associations on update', async () => {
    const client = fakeClient();
    await upsertActivity(key, input, { client });
    const before = client.requests.filter((r: any) => r.path === '/associations/relations').length;
    await upsertActivity(key, { ...input, values: { ...input.values, activity_notes: 'changed' } }, { client });
    const after = client.requests.filter((r: any) => r.path === '/associations/relations').length;
    expect(after).toBe(before);
  });
});

describe('findActivityBySource', () => {
  it('filters server-side on properties.<key> — the shape probed live', async () => {
    const client = fakeClient();
    await upsertActivity(key, input, { client });
    client.requests.length = 0;

    const hit = await findActivityBySource(key, client);
    expect(hit).not.toBeNull();
    const search = client.requests.find((r: any) => r.path.endsWith('/records/search'));
    // The source filter uses the option KEY — filtering on the label finds nothing (verified live).
    expect(search.body.filters).toEqual([
      { field: `properties.${SOURCE_ID_FIELD}`, operator: 'eq', value: 'appt-123' },
      { field: `properties.${SOURCE_FIELD}`, operator: 'eq', value: 'appointment' },
    ]);
  });

  it('returns null for an unknown source id without searching on a blank', async () => {
    const client = fakeClient();
    expect(await findActivityBySource({ source: 'Appointment', sourceRecordId: '' }, client)).toBeNull();
    expect(client.requests.length).toBe(0);
  });
});

describe('a claim that outlived its record', () => {
  /**
   * Someone deletes a bad activity in GHL by hand. The claims ledger (or the search index) still
   * points at the dead id, so reading it 404s. Before this was handled, that source event could
   * never be ingested again — every future delivery threw on the same missing record, and the
   * meeting silently stopped existing for reporting purposes.
   */
  function clientWithGhost() {
    const base = fakeClient();
    const inner = base.request.bind(base);
    base.request = async (args: any) => {
      const { method = 'GET', path } = args;
      // The source lookup finds a record that has since been deleted.
      if (method === 'POST' && path === `/objects/${ACTIVITIES_OBJECT}/records/search`) {
        return { records: [{ id: 'ghost', properties: { [SOURCE_ID_FIELD]: 'appt-123' } }], total: 1 };
      }
      if (method === 'GET' && path === `/objects/${ACTIVITIES_OBJECT}/records/ghost`) {
        throw new GhlApiError({ status: 404, body: { message: 'Record not found' }, method, path, attempts: 1 });
      }
      return inner(args);
    };
    return base;
  }

  it('recovers by creating a fresh record instead of throwing forever', async () => {
    const client = clientWithGhost();
    const res = await upsertActivity(key, input, { client });
    expect(res.outcome).toBe('created');
    expect(res.recordId).not.toBe('ghost');
    const stored = client.records.get(res.recordId);
    expect(stored[SOURCE_ID_FIELD]).toBe('appt-123');
  });

  it('reports would-create on a dry run, without writing', async () => {
    const client = clientWithGhost();
    const before = client.records.size;
    const res = await upsertActivity(key, input, { client, plan: true });
    expect(res.outcome).toBe('would-create');
    expect(client.records.size).toBe(before);
  });

  it('still surfaces a genuine error rather than masking it as a create', async () => {
    // A 500 is not "the record is gone" — it must propagate, or a transient outage would quietly
    // duplicate every activity it touched.
    const client = fakeClient();
    const inner = client.request.bind(client);
    client.request = async (args: any) => {
      if (args.method === 'POST' && args.path === `/objects/${ACTIVITIES_OBJECT}/records/search`) {
        return { records: [{ id: 'ghost', properties: { [SOURCE_ID_FIELD]: 'appt-123' } }], total: 1 };
      }
      if ((args.method ?? 'GET') === 'GET' && args.path === `/objects/${ACTIVITIES_OBJECT}/records/ghost`) {
        throw new GhlApiError({ status: 500, body: {}, method: 'GET', path: args.path, attempts: 3 });
      }
      return inner(args);
    };
    await expect(upsertActivity(key, input, { client })).rejects.toThrow(/500/);
  });
});
