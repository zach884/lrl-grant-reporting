import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture change-log calls instead of hitting the DB.
vi.mock('../../audit/log', () => ({ logChange: vi.fn(async () => {}) }));

import { logChange } from '../../audit/log';
import { syncContactToWix } from '../sync';
import type { Contact, CustomFieldCatalog, CustomFieldDef } from '../../ghl/types';
import type { WixMappingSet } from '../../mapping/wixTypes';
import type { WixCollectionSchema } from '../../wix/types';

const mockLog = logChange as unknown as ReturnType<typeof vi.fn>;

function cat(fields: CustomFieldDef[]): CustomFieldCatalog {
  const byKey: Record<string, CustomFieldDef> = {}; const byId: Record<string, CustomFieldDef> = {};
  for (const f of fields) { byKey[f.fieldKey] = f; byId[f.id] = f; }
  return { fields, folders: [], byKey, byId };
}
const catalog = cat([{ id: 'bioId', name: 'Bio', fieldKey: 'contact.bio', dataType: 'LARGE_TEXT' }]);
const contact: Contact = { id: 'c1', firstName: 'Zach', lastName: 'K', email: 'z@x.io', customFields: [{ id: 'bioId', value: 'Founder' }] };
const schema: WixCollectionSchema = {
  id: 'Team', displayName: 'Team', displayField: 'title_fld',
  columns: [
    { key: 'title_fld', displayName: 'Name', type: 'TEXT' },
    { key: 'email', displayName: 'Email', type: 'EMAIL' },
    { key: 'bio', displayName: 'Bio', type: 'TEXT' },
    { key: 'ghlContactId', displayName: 'GHL Contact ID', type: 'TEXT' },
  ],
};
function baseSet(): WixMappingSet {
  return {
    id: 's1', name: 'Contact→Team', sourceObject: 'contact', wixSiteId: 'site', wixCollectionId: 'Team',
    matchSourceField: 'id', matchTargetColumn: 'ghlContactId', policy: 'overwrite', enabled: true, version: 1, updatedAt: '',
    rows: [{ sourceFieldKey: 'fullName', targetColumnKey: 'title_fld' }, { sourceFieldKey: 'email', targetColumnKey: 'email' }, { sourceFieldKey: 'contact.bio', targetColumnKey: 'bio' }],
  };
}
const ghlStub = { request: async () => ({ contact }) } as any;
function wixStub(teamItem: any) {
  const client = {
    request: async ({ path, body }: any) => {
      if (path === '/wix-data/v2/items/query') return { dataItems: body?.dataCollectionId === 'Team' && teamItem ? [{ data: teamItem }] : [] };
      if (path === '/wix-data/v2/items') return { dataItem: { data: { _id: 'newItem', ...body.dataItem.data } } };
      return {};
    },
  } as any;
  return { client };
}

beforeEach(() => mockLog.mockReset().mockResolvedValue(undefined));

describe('Wix sync change-log instrumentation', () => {
  it('logs a create with field diffs on insert (applied)', async () => {
    const { client } = wixStub(null);
    await syncContactToWix('c1', baseSet(), catalog, schema, { apply: true, client, ghlClient: ghlStub });
    expect(mockLog).toHaveBeenCalledTimes(1);
    const ev = mockLog.mock.calls[0][0];
    expect(ev).toMatchObject({ app: 'wix', objectType: 'wix:Contact→Team', actorKind: 'sync', actorName: 'wix:Contact→Team', action: 'create', method: 'sync', applied: true, recordId: 'newItem' });
    expect(ev.changes.map((c: any) => c.field)).toEqual(expect.arrayContaining(['title_fld', 'email', 'bio']));
  });

  it('logs an update on patch of a changed field', async () => {
    const { client } = wixStub({ _id: 'i1', title_fld: 'Zach K', email: 'old@x.io', bio: 'Founder', ghlContactId: 'c1' });
    await syncContactToWix('c1', baseSet(), catalog, schema, { apply: true, client, ghlClient: ghlStub });
    expect(mockLog).toHaveBeenCalledTimes(1);
    const ev = mockLog.mock.calls[0][0];
    expect(ev).toMatchObject({ action: 'update', applied: true, recordId: 'i1' });
    expect(ev.changes).toEqual([{ field: 'email', from: 'old@x.io', to: 'z@x.io' }]);
  });

  it('does NOT log when the row already matches (no-op)', async () => {
    const { client } = wixStub({ _id: 'i1', title_fld: 'Zach K', email: 'z@x.io', bio: 'Founder', ghlContactId: 'c1' });
    await syncContactToWix('c1', baseSet(), catalog, schema, { apply: true, client, ghlClient: ghlStub });
    expect(mockLog).not.toHaveBeenCalled();
  });

  it('logs a dry-run insert with applied:false', async () => {
    const { client } = wixStub(null);
    await syncContactToWix('c1', baseSet(), catalog, schema, { apply: false, client, ghlClient: ghlStub });
    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog.mock.calls[0][0]).toMatchObject({ action: 'create', applied: false });
  });
});
