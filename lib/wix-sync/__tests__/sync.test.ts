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

// --- status gate / visibility / write-back (P1) ---
const gateCatalog = cat([
  { id: 'bioId', name: 'Bio', fieldKey: 'contact.bio', dataType: 'LARGE_TEXT' },
  { id: 'statusId', name: 'Status', fieldKey: 'contact.status', dataType: 'TEXT' },
]);
const gateSchema: WixCollectionSchema = {
  id: 'Team', displayName: 'Team', displayField: 'title_fld',
  columns: [
    { key: 'title_fld', displayName: 'Name', type: 'TEXT' },
    { key: 'bio', displayName: 'Bio', type: 'TEXT' },
    { key: 'ghlContactId', displayName: 'GHL Contact ID', type: 'TEXT' },
    { key: 'Status', displayName: 'Status', type: 'TEXT' },
  ],
};
function mkContact(status: string): Contact {
  return { id: 'c1', firstName: 'Zach', lastName: 'K', email: 'z@x.io', customFields: [{ id: 'bioId', value: 'Founder' }, { id: 'statusId', value: status }] };
}
function ghlRec(c: Contact) {
  const calls: any[] = [];
  const client = { request: async (o: any) => { calls.push(o); return { contact: c }; } } as any;
  return { client, calls };
}
function gateSet(): WixMappingSet {
  return {
    ...baseSet([
      { sourceFieldKey: 'fullName', targetColumnKey: 'title_fld' },
      { sourceFieldKey: 'contact.bio', targetColumnKey: 'bio' },
    ]),
    gate: { field: 'contact.status', actions: { Approved: 'upsert', Published: 'update', Hidden: 'hide', Pending: 'skip', '': 'skip' }, onPublishSetStatus: 'Published' },
    visibility: { mode: 'publishState' },
  };
}
/** Pull the _publishStatus value out of a recorded bulk-patch call, if any. */
function patchedPublishStatus(calls: Array<{ path: string; body: any }>): string | undefined {
  const patch = calls.find((c) => c.path === '/wix-data/v2/bulk/items/patch'
    && (c.body?.patches?.[0]?.fieldModifications ?? []).some((m: any) => m.fieldPath === '_publishStatus'));
  return patch?.body.patches[0].fieldModifications.find((m: any) => m.fieldPath === '_publishStatus')?.setFieldOptions?.value;
}

describe('syncContactToWix — status gate', () => {
  it('Pending → skip (never create)', async () => {
    const { client, calls } = wixStub(null);
    const r = await syncContactToWix('c1', gateSet(), gateCatalog, gateSchema, { apply: true, client, ghlClient: ghlRec(mkContact('Pending')).client });
    expect(r.action).toBe('skip');
    expect(calls.some((c) => c.path === '/wix-data/v2/items')).toBe(false);
  });

  it('Approved + no row → insert, then PUBLISH it, and write status back to Published', async () => {
    const { client, calls } = wixStub(null);
    const g = ghlRec(mkContact('Approved'));
    const r = await syncContactToWix('c1', gateSet(), gateCatalog, gateSchema, { apply: true, client, ghlClient: g.client });
    expect(r.action).toBe('insert');
    const insert = calls.find((c) => c.path === '/wix-data/v2/items');
    expect(insert!.body.dataItem.data).toMatchObject({ ghlContactId: 'c1' });
    expect(patchedPublishStatus(calls)).toBe('PUBLISHED');                  // insert lands DRAFT → published
    expect(g.calls.some((c) => c.method === 'PUT' && String(c.path).includes('/contacts/'))).toBe(true);
  });

  it('Hidden + existing published → unpublishes it (DRAFT), no create', async () => {
    const { client, calls } = wixStub({ _id: 'i1', title_fld: 'Zach K', bio: 'Founder', ghlContactId: 'c1', _publishStatus: 'PUBLISHED' });
    const r = await syncContactToWix('c1', gateSet(), gateCatalog, gateSchema, { apply: true, client, ghlClient: ghlRec(mkContact('Hidden')).client });
    expect(r.action).toBe('hide');
    expect(patchedPublishStatus(calls)).toBe('DRAFT');
    expect(calls.some((c) => c.path === '/wix-data/v2/items')).toBe(false);
  });

  it('Published + no row → update-only skip (does not create)', async () => {
    const { client, calls } = wixStub(null);
    const r = await syncContactToWix('c1', gateSet(), gateCatalog, gateSchema, { apply: true, client, ghlClient: ghlRec(mkContact('Published')).client });
    expect(r.action).toBe('skip');
    expect(calls.some((c) => c.path === '/wix-data/v2/items')).toBe(false);
  });
});

// --- dedup: email-first link + id write-back (P1 #3) ---
const dedupCatalog = cat([
  { id: 'bioId', name: 'Bio', fieldKey: 'contact.bio', dataType: 'LARGE_TEXT' },
  { id: 'wtrId', name: 'Wix Team Row', fieldKey: 'contact.wix_team_row_id', dataType: 'TEXT' },
]);
function dedupSet(): WixMappingSet {
  return {
    ...baseSet([
      { sourceFieldKey: 'fullName', targetColumnKey: 'title_fld' },
      { sourceFieldKey: 'email', targetColumnKey: 'email' },
      { sourceFieldKey: 'contact.bio', targetColumnKey: 'bio' },
    ]),
    secondaryMatch: [{ sourceField: 'email', targetColumn: 'email' }],
    writebackField: 'contact.wix_team_row_id',
  };
}
/** Stub whose query result depends on the filtered column (ghlContactId vs email). */
function wixDedup(onGhlId: any, onEmail: any[]) {
  const calls: Array<{ path: string; method: string; body: any }> = [];
  const client = {
    request: async ({ path, method = 'GET', body }: any) => {
      calls.push({ path, method, body });
      if (path === '/wix-data/v2/items/query') {
        const f = body?.query?.filter ?? {};
        if ('ghlContactId' in f) return { dataItems: onGhlId ? [{ data: onGhlId }] : [] };
        if ('email' in f) return { dataItems: onEmail.map((d) => ({ data: d })) };
        return { dataItems: [] };
      }
      if (path === '/wix-data/v2/items') return { dataItem: { data: { _id: 'newItem', ...body.dataItem.data } } };
      return {};
    },
  } as any;
  return { client, calls };
}

describe('syncContactToWix — dedup + id write-back', () => {
  it('adopts an existing row by email when the id key misses, stamping ghlContactId', async () => {
    const { client, calls } = wixDedup(null, [{ _id: 'i9', title_fld: 'Zach K', email: 'z@x.io', bio: 'OldBio' }]);
    const r = await syncContactToWix('c1', dedupSet(), dedupCatalog, schema, { apply: true, client, ghlClient: ghlRec(contact).client });
    expect(r.action).toBe('patch');                                         // adopted, not inserted
    expect(calls.some((c) => c.path === '/wix-data/v2/items')).toBe(false); // no insert
    const patch = calls.find((c) => c.path === '/wix-data/v2/bulk/items/patch');
    const mods = patch!.body.patches[0].fieldModifications;
    expect(mods.some((m: any) => m.fieldPath === 'ghlContactId' && m.setFieldOptions.value === 'c1')).toBe(true);
  });

  it('defers to review (skip, no create) when the secondary key matches multiple rows', async () => {
    const { client, calls } = wixDedup(null, [{ _id: 'a', email: 'z@x.io' }, { _id: 'b', email: 'z@x.io' }]);
    const r = await syncContactToWix('c1', dedupSet(), dedupCatalog, schema, { apply: true, client, ghlClient: ghlRec(contact).client });
    expect(r.action).toBe('skip');
    expect(r.note).toMatch(/needs review/);
    expect(calls.some((c) => c.path === '/wix-data/v2/items')).toBe(false);
  });

  it('writes the new Wix row id back to the GHL contact after insert', async () => {
    const { client } = wixDedup(null, []); // no id match, no email match → insert
    const g = ghlRec(contact);
    const r = await syncContactToWix('c1', dedupSet(), dedupCatalog, schema, { apply: true, client, ghlClient: g.client });
    expect(r.action).toBe('insert');
    expect(r.itemId).toBe('newItem');
    expect(g.calls.some((c) => c.method === 'PUT' && String(c.path).includes('/contacts/'))).toBe(true);
  });
});
