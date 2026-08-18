// Convergence: a sync of unchanged data must write NOTHING and report `noop`.
//
// Before 2026-08-17 only `kind:'value'` was equality-guarded. Image and reference intents pushed
// unconditionally, so any set mapping either could never report noop: 126 duplicate Media Manager
// uploads and 269 reference replaces in 13 days, every Wix row's _updatedDate churning nightly.

import { describe, it, expect } from 'vitest';
import { syncContactToWix, planImageWrite, imageSourceColumn } from '../sync';
import type { Contact, CustomFieldCatalog, CustomFieldDef } from '../../ghl/types';
import type { WixMappingSet } from '../../mapping/wixTypes';
import type { WixCollectionSchema, WixColumn } from '../../wix/types';

function cat(fields: CustomFieldDef[]): CustomFieldCatalog {
  const byKey: Record<string, CustomFieldDef> = {};
  const byId: Record<string, CustomFieldDef> = {};
  for (const f of fields) { byKey[f.fieldKey] = f; byId[f.id] = f; }
  return { fields, folders: [], byKey, byId };
}

const HEADSHOT = 'https://services.leadconnectorhq.com/documents/download/abc123';

const catalog = cat([
  { id: 'progId', name: 'Program', fieldKey: 'contact.program', dataType: 'MULTIPLE_OPTIONS', options: [{ key: 'local', label: 'LOCAL' }] },
  { id: 'photoId', name: 'Headshot', fieldKey: 'contact.headshot', dataType: 'FILE_UPLOAD' },
]);

const contact: Contact = {
  id: 'c1', firstName: 'Zach', lastName: 'K', email: 'z@x.io',
  customFields: [
    { id: 'progId', value: ['local'] },
    // the uuid-keyed form-upload shape
    { id: 'photoId', value: { 'uuid-1': { meta: { name: 'p.jpg' }, url: HEADSHOT } } },
  ],
};

const ghlStub = { request: async () => ({ contact }) } as any;

/** Schema with an IMAGE column; `withCompanion` adds the `image_fldSrc` provenance column. */
function schemaFor(withCompanion: boolean): WixCollectionSchema {
  const columns: WixColumn[] = [
    { key: 'title_fld', displayName: 'Name', type: 'TEXT' },
    { key: 'ghlContactId', displayName: 'GHL Contact ID', type: 'TEXT' },
    { key: 'program', displayName: 'Program', type: 'MULTI_REFERENCE', referencedCollectionId: 'Programs' },
    { key: 'image_fld', displayName: 'Headshot', type: 'IMAGE' },
  ];
  if (withCompanion) columns.push({ key: 'image_fldSrc', displayName: 'Headshot source', type: 'TEXT' });
  return { id: 'Team', displayName: 'Team', displayField: 'title_fld', columns };
}

function setWith(rows: WixMappingSet['rows']): WixMappingSet {
  return {
    id: 's1', name: 'Contact→Team', sourceObject: 'contact',
    wixSiteId: 'site', wixCollectionId: 'Team',
    matchSourceField: 'id', matchTargetColumn: 'ghlContactId',
    policy: 'overwrite', enabled: true, version: 1, updatedAt: '', rows,
  };
}

/** A Wix stub that PERSISTS inserts/patches, so a second sync sees the first one's result. */
function statefulWix(initialRow: any | null) {
  let row: any | null = initialRow ? { ...initialRow } : null;
  const calls: Array<{ path: string; method: string; body: any }> = [];
  let importCount = 0;
  const client = {
    request: async ({ path, method = 'GET', body }: any) => {
      calls.push({ path, method, body });
      if (path === '/wix-data/v2/items/query') {
        const coll = body?.dataCollectionId;
        if (coll === 'Team') return { dataItems: row ? [{ data: row }] : [] };
        if (coll === 'Programs') return { dataItems: [{ data: { _id: 'p1', title: 'LOCAL' } }] };
        return { dataItems: [] };
      }
      if (path === '/wix-data/v2/items' && method === 'POST') {
        row = { _id: 'newItem', ...body.dataItem.data };
        return { dataItem: { data: row } };
      }
      if (path === '/wix-data/v2/bulk/items/patch') {
        for (const m of body.patches[0].fieldModifications) {
          if (m.fieldPath === '_publishStatus') row._publishStatus = m.setFieldOptions.value;
          else row[m.fieldPath] = m.setFieldOptions.value;
        }
        return {};
      }
      if (path === '/wix-data/v2/items/replace-references') {
        row[body.referringItemFieldName] = body.newReferencedItemIds.map((id: string) => ({ _id: id }));
        return {};
      }
      if (path === '/site-media/v1/files/import') {
        importCount += 1;
        // Wix re-hosts: a fresh id each import, which is exactly why the stored value can never
        // be compared against the GHL source url.
        return { file: { id: `f${importCount}`, url: `wix:image://v1/copy${importCount}/p.jpg` } };
      }
      if (path.startsWith('/wix-data/v2/collections/')) {
        return { collection: { id: 'Programs', displayField: 'title', fields: [{ key: 'title', type: 'TEXT' }] } };
      }
      return {};
    },
  } as any;
  return {
    client,
    calls,
    get row() { return row; },
    get importCount() { return importCount; },
    refWrites: () => calls.filter((c) => c.path === '/wix-data/v2/items/replace-references').length,
  };
}

describe('reference convergence', () => {
  const set = setWith([
    { sourceFieldKey: 'fullName', targetColumnKey: 'title_fld' },
    { sourceFieldKey: 'contact.program', targetColumnKey: 'program' },
  ]);

  it('reports noop and skips replaceReferences when the id set already matches', async () => {
    const wixp = statefulWix({
      _id: 'i1', title_fld: 'Zach K', ghlContactId: 'c1',
      program: [{ _id: 'p1', title: 'LOCAL' }], // inlined by includeReferencedItems
    });
    const r = await syncContactToWix('c1', set, catalog, schemaFor(false), { apply: true, client: wixp.client, ghlClient: ghlStub });

    expect(r.action).toBe('noop');
    expect(wixp.refWrites()).toBe(0);
  });

  it('asks for the reference columns to be inlined on the match query', async () => {
    const wixp = statefulWix(null);
    await syncContactToWix('c1', set, catalog, schemaFor(false), { apply: false, client: wixp.client, ghlClient: ghlStub });
    const q = wixp.calls.find((c) => c.path === '/wix-data/v2/items/query' && c.body?.dataCollectionId === 'Team');
    expect(q!.body.includeReferencedItems).toEqual(['program']);
  });

  it('still writes references when the target set genuinely differs', async () => {
    const wixp = statefulWix({
      _id: 'i1', title_fld: 'Zach K', ghlContactId: 'c1',
      program: [{ _id: 'someOtherProgram' }],
    });
    const r = await syncContactToWix('c1', set, catalog, schemaFor(false), { apply: true, client: wixp.client, ghlClient: ghlStub });

    expect(r.action).toBe('patch');
    expect(wixp.refWrites()).toBe(1);
  });
});

describe('image convergence', () => {
  const set = setWith([
    { sourceFieldKey: 'fullName', targetColumnKey: 'title_fld' },
    { sourceFieldKey: 'contact.headshot', targetColumnKey: 'image_fld' },
  ]);

  it('with a companion column: re-import is skipped when the source url is unchanged', async () => {
    const wixp = statefulWix({
      _id: 'i1', title_fld: 'Zach K', ghlContactId: 'c1',
      image_fld: 'wix:image://v1/old/p.jpg', image_fldSrc: HEADSHOT,
    });
    const r = await syncContactToWix('c1', set, catalog, schemaFor(true), { apply: true, client: wixp.client, ghlClient: ghlStub });

    expect(r.action).toBe('noop');
    expect(wixp.importCount).toBe(0);
  });

  it('with a companion column: a CHANGED source url re-imports and re-stamps provenance', async () => {
    const wixp = statefulWix({
      _id: 'i1', title_fld: 'Zach K', ghlContactId: 'c1',
      image_fld: 'wix:image://v1/old/p.jpg', image_fldSrc: 'https://old.example/previous.jpg',
    });
    const r = await syncContactToWix('c1', set, catalog, schemaFor(true), { apply: true, client: wixp.client, ghlClient: ghlStub });

    expect(r.action).toBe('patch');
    expect(wixp.importCount).toBe(1);
    expect(wixp.row.image_fldSrc).toBe(HEADSHOT); // so the NEXT run is a noop
  });

  it('with an empty companion column: adopts the existing image without re-importing', async () => {
    const wixp = statefulWix({
      _id: 'i1', title_fld: 'Zach K', ghlContactId: 'c1',
      image_fld: 'wix:image://v1/existing/p.jpg', // pre-guard row: correct file, no provenance
    });
    const r = await syncContactToWix('c1', set, catalog, schemaFor(true), { apply: true, client: wixp.client, ghlClient: ghlStub });

    expect(wixp.importCount).toBe(0);
    expect(wixp.row.image_fldSrc).toBe(HEADSHOT);
    expect(wixp.row.image_fld).toBe('wix:image://v1/existing/p.jpg'); // untouched
  });

  it('without a companion column: refuses to re-import over an existing image', async () => {
    const wixp = statefulWix({
      _id: 'i1', title_fld: 'Zach K', ghlContactId: 'c1', image_fld: 'wix:image://v1/old/p.jpg',
    });
    const r = await syncContactToWix('c1', set, catalog, schemaFor(false), { apply: true, client: wixp.client, ghlClient: ghlStub });

    expect(wixp.importCount).toBe(0);
    expect(r.action).toBe('noop');
    expect(r.skipped.some((s) => s.reason.includes('duplicate Media Manager upload'))).toBe(true);
  });

  it('forceImages re-imports deliberately', async () => {
    const wixp = statefulWix({
      _id: 'i1', title_fld: 'Zach K', ghlContactId: 'c1',
      image_fld: 'wix:image://v1/old/p.jpg', image_fldSrc: HEADSHOT,
    });
    await syncContactToWix('c1', set, catalog, schemaFor(true), { apply: true, client: wixp.client, ghlClient: ghlStub, forceImages: true });
    expect(wixp.importCount).toBe(1);
  });
});

describe('the acceptance criterion: two consecutive syncs of one contact', () => {
  it('run 1 inserts, run 2 is a pure noop — no re-import, no reference replace', async () => {
    const set = setWith([
      { sourceFieldKey: 'fullName', targetColumnKey: 'title_fld' },
      { sourceFieldKey: 'contact.program', targetColumnKey: 'program' },
      { sourceFieldKey: 'contact.headshot', targetColumnKey: 'image_fld' },
    ]);
    const wixp = statefulWix(null);
    const schema = schemaFor(true);

    const run1 = await syncContactToWix('c1', set, catalog, schema, { apply: true, client: wixp.client, ghlClient: ghlStub });
    expect(run1.action).toBe('insert');
    expect(wixp.importCount).toBe(1);
    expect(wixp.refWrites()).toBe(1);

    const run2 = await syncContactToWix('c1', set, catalog, schema, { apply: true, client: wixp.client, ghlClient: ghlStub });
    expect(run2.action).toBe('noop');
    expect(run2.written).toHaveLength(0);
    expect(wixp.importCount).toBe(1); // still 1 — no second Media Manager copy
    expect(wixp.refWrites()).toBe(1); // still 1 — references untouched
  });
});

describe('planImageWrite / imageSourceColumn', () => {
  const cols = new Map<string, WixColumn>([
    ['logo', { key: 'logo', displayName: 'Logo', type: 'IMAGE' }],
    ['logoSrc', { key: 'logoSrc', displayName: 'Logo source', type: 'TEXT' }],
  ]);

  it('finds the companion column by convention, and only when it exists', () => {
    expect(imageSourceColumn('logo', cols)).toBe('logoSrc');
    expect(imageSourceColumn('image_fld', cols)).toBeUndefined();
  });

  it('always imports for a brand-new row', () => {
    expect(planImageWrite(null, 'logo', 'logoSrc', 'https://x/a.png', false)).toEqual({ kind: 'import' });
  });

  it('ignores trailing whitespace when comparing source urls', () => {
    const row = { logo: 'wix:image://v1/x/a.png', logoSrc: ' https://x/a.png ' };
    expect(planImageWrite(row, 'logo', 'logoSrc', 'https://x/a.png', false)).toEqual({ kind: 'unchanged' });
  });

  it('imports when the companion column exists but the image is missing', () => {
    expect(planImageWrite({ logoSrc: '' }, 'logo', 'logoSrc', 'https://x/a.png', false)).toEqual({ kind: 'import' });
  });
});
