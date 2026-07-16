import { describe, it, expect } from 'vitest';
import { syncContactToWix } from '../sync';
import type { Contact, CustomFieldCatalog, CustomFieldDef } from '../../ghl/types';
import type { WixMappingSet } from '../../mapping/wixTypes';
import type { WixCollectionSchema } from '../../wix/types';

function cat(fields: CustomFieldDef[]): CustomFieldCatalog {
  const byKey: Record<string, CustomFieldDef> = {};
  const byId: Record<string, CustomFieldDef> = {};
  for (const f of fields) { byKey[f.fieldKey] = f; byId[f.id] = f; }
  return { fields, folders: [], byKey, byId };
}

const catalog = cat([
  { id: 'bioId', name: 'Bio', fieldKey: 'contact.bio', dataType: 'LARGE_TEXT' },
  { id: 'progId', name: 'Program', fieldKey: 'contact.program', dataType: 'MULTIPLE_OPTIONS', options: [{ key: 'local', label: 'LOCAL' }] },
]);

const contact: Contact = {
  id: 'c1', firstName: 'Zach', lastName: 'K', email: 'z@x.io',
  customFields: [{ id: 'bioId', value: 'Founder' }, { id: 'progId', value: ['local'] }],
};

const schema: WixCollectionSchema = {
  id: 'Team', displayName: 'Team', displayField: 'title_fld',
  columns: [
    { key: 'title_fld', displayName: 'Name', type: 'TEXT' },
    { key: 'email', displayName: 'Email', type: 'EMAIL' },
    { key: 'bio', displayName: 'Bio', type: 'TEXT' },
    { key: 'ghlContactId', displayName: 'GHL Contact ID', type: 'TEXT' },
    { key: 'program', displayName: 'Program', type: 'MULTI_REFERENCE', referencedCollectionId: 'Programs' },
  ],
};

function baseSet(rows: WixMappingSet['rows']): WixMappingSet {
  return {
    id: 's1', name: 'Contact→Team', sourceObject: 'contact',
    wixSiteId: 'site', wixCollectionId: 'Team',
    matchSourceField: 'id', matchTargetColumn: 'ghlContactId',
    policy: 'overwrite', enabled: true, version: 1, updatedAt: '', rows,
  };
}

const ghlStub = { request: async () => ({ contact }) } as any;

/** A recording Wix client whose query result for the Team collection is configurable. */
function wixStub(teamItem: any) {
  const calls: Array<{ path: string; method: string; body: any }> = [];
  const client = {
    request: async ({ path, method = 'GET', body }: any) => {
      calls.push({ path, method, body });
      if (path === '/wix-data/v2/items/query') {
        const coll = body?.dataCollectionId;
        if (coll === 'Team') return { dataItems: teamItem ? [{ data: teamItem }] : [] };
        if (coll === 'Programs') return { dataItems: [{ data: { _id: 'p1', title: 'LOCAL' } }] };
        return { dataItems: [] };
      }
      if (path === '/wix-data/v2/items') return { dataItem: { data: { _id: 'newItem', ...body.dataItem.data } } };
      if (path.startsWith('/wix-data/v2/collections/')) {
        return { collection: { id: 'Programs', displayField: 'title', fields: [{ key: 'title', type: 'TEXT' }] } };
      }
      return {};
    },
  } as any;
  return { client, calls };
}

describe('syncContactToWix', () => {
  it('inserts a new row when no match exists, with the match key set', async () => {
    const { client, calls } = wixStub(null);
    const set = baseSet([
      { sourceFieldKey: 'fullName', targetColumnKey: 'title_fld' },
      { sourceFieldKey: 'email', targetColumnKey: 'email' },
      { sourceFieldKey: 'contact.bio', targetColumnKey: 'bio' },
    ]);
    const r = await syncContactToWix('c1', set, catalog, schema, { apply: true, client, ghlClient: ghlStub });
    expect(r.action).toBe('insert');
    expect(r.itemId).toBe('newItem');
    const insert = calls.find((c) => c.path === '/wix-data/v2/items');
    expect(insert!.body.dataItem.data).toMatchObject({
      title_fld: 'Zach K', email: 'z@x.io', bio: 'Founder', ghlContactId: 'c1',
    });
  });

  it('is a no-op when the Wix row already matches (idempotent)', async () => {
    const { client, calls } = wixStub({ _id: 'i1', title_fld: 'Zach K', email: 'z@x.io', bio: 'Founder', ghlContactId: 'c1' });
    const set = baseSet([
      { sourceFieldKey: 'fullName', targetColumnKey: 'title_fld' },
      { sourceFieldKey: 'email', targetColumnKey: 'email' },
      { sourceFieldKey: 'contact.bio', targetColumnKey: 'bio' },
    ]);
    const r = await syncContactToWix('c1', set, catalog, schema, { apply: true, client, ghlClient: ghlStub });
    expect(r.action).toBe('noop');
    expect(r.unchanged).toBe(3);
    expect(r.written).toHaveLength(0);
    expect(calls.some((c) => c.path === '/wix-data/v2/bulk/items/patch')).toBe(false);
  });

  it('patches only the changed field on an existing row', async () => {
    const { client, calls } = wixStub({ _id: 'i1', title_fld: 'Zach K', email: 'old@x.io', bio: 'Founder', ghlContactId: 'c1' });
    const set = baseSet([
      { sourceFieldKey: 'fullName', targetColumnKey: 'title_fld' },
      { sourceFieldKey: 'email', targetColumnKey: 'email' },
      { sourceFieldKey: 'contact.bio', targetColumnKey: 'bio' },
    ]);
    const r = await syncContactToWix('c1', set, catalog, schema, { apply: true, client, ghlClient: ghlStub });
    expect(r.action).toBe('patch');
    expect(r.unchanged).toBe(2);
    const patch = calls.find((c) => c.path === '/wix-data/v2/bulk/items/patch');
    const mods = patch!.body.patches[0].fieldModifications;
    expect(mods).toHaveLength(1);
    expect(mods[0].fieldPath).toBe('email');
    expect(mods[0].setFieldOptions.value).toBe('z@x.io');
  });

  it('resolves a multi-select to references and writes them post-upsert', async () => {
    const { client, calls } = wixStub(null);
    const set = baseSet([
      { sourceFieldKey: 'fullName', targetColumnKey: 'title_fld' },
      { sourceFieldKey: 'contact.program', targetColumnKey: 'program' },
    ]);
    const r = await syncContactToWix('c1', set, catalog, schema, { apply: true, client, ghlClient: ghlStub });
    expect(r.action).toBe('insert');
    const refWrite = calls.find((c) => c.path === '/wix-data/v2/items/replace-references');
    expect(refWrite!.body).toMatchObject({ referringItemId: 'newItem', referringItemFieldName: 'program', newReferencedItemIds: ['p1'] });
  });

  it('dry-run plans without writing', async () => {
    const { client, calls } = wixStub(null);
    const set = baseSet([{ sourceFieldKey: 'email', targetColumnKey: 'email' }]);
    const r = await syncContactToWix('c1', set, catalog, schema, { apply: false, client, ghlClient: ghlStub });
    expect(r.dryRun).toBe(true);
    expect(r.action).toBe('insert');
    expect(calls.some((c) => c.method === 'POST' && c.path === '/wix-data/v2/items')).toBe(false);
  });
});
