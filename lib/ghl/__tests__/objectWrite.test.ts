// The write contract that cost us 18 days of resource stop values. Every test here maps to a
// row of the live evidence matrix in docs/sprints/multiselect-write-fix.md §1.

import { describe, it, expect } from 'vitest';
import { applyObjectWrite, didPersist } from '../objectWrite';
import { coerceObjectProperties } from '../coerce';
import type { CustomFieldDef } from '../types';

const OBJ = 'custom_objects.resources';

const catalog: Record<string, CustomFieldDef> = {
  [`${OBJ}.mrl_stops`]: {
    id: '1', name: 'MRL Stops', fieldKey: `${OBJ}.mrl_stops`, dataType: 'MULTIPLE_OPTIONS',
    options: [1, 2, 3, 4].map((n) => ({ key: String(n), label: String(n) })),
  },
  [`${OBJ}.resource_logo`]: {
    id: '2', name: 'Resource Logo', fieldKey: `${OBJ}.resource_logo`, dataType: 'FILE_UPLOAD',
  },
  [`${OBJ}.resources`]: {
    id: '3', name: 'Resource Name', fieldKey: `${OBJ}.resources`, dataType: 'TEXT',
  },
  [`${OBJ}.resource_status`]: {
    id: '4', name: 'Status', fieldKey: `${OBJ}.resource_status`, dataType: 'SINGLE_OPTIONS',
    options: [{ key: 'approved', label: 'Approved' }, { key: 'published', label: 'Published' }],
  },
};

/** A fake GHL client that records requests and serves a mutable record. */
function fakeClient(stored: Record<string, unknown>, opts: { storeWrites?: boolean } = {}) {
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  const record = { ...stored };
  return {
    requests,
    record,
    locationId: 'LOC',
    async request({ method = 'GET', path, body }: any) {
      requests.push({ method, path, body });
      if (method === 'PUT') {
        // Emulate GHL: apply add/remove modifiers, set plain values. `storeWrites: false`
        // emulates the "200 but stores nothing" failure mode.
        if (opts.storeWrites !== false) {
          for (const [k, v] of Object.entries(body.properties as Record<string, any>)) {
            if (v && typeof v === 'object' && ('add' in v || 'remove' in v)) {
              const cur = Array.isArray(record[k]) ? [...(record[k] as any[])] : [];
              const unwrap = (x: any) => (x && typeof x === 'object' && 'url' in x ? x.url : x);
              const removed = (v.remove ?? []).map(unwrap);
              const next = cur.filter((x) => !removed.includes(unwrap(x)));
              for (const a of (v.add ?? []).map(unwrap)) if (!next.includes(a)) next.push(a);
              record[k] = next;
            } else {
              record[k] = v;
            }
          }
        }
        return {};
      }
      return { record: { properties: record } };
    },
  } as any;
}

const puts = (c: any) => c.requests.filter((r: any) => r.method === 'PUT');

describe('applyObjectWrite — MULTIPLE_OPTIONS modifier diff', () => {
  it('sends {add,remove} computed against the current value, never a bare array or string', async () => {
    const client = fakeClient({ mrl_stops: ['1', '2'] });
    const coerced = coerceObjectProperties(OBJ, { mrl_stops: ['2', '3'] }, catalog);
    const r = await applyObjectWrite(OBJ, 'rec1', coerced, catalog, client);

    expect(puts(client)).toHaveLength(1);
    expect(puts(client)[0].body.properties.mrl_stops).toEqual({ add: ['3'], remove: ['1'] });
    expect(r.written).toEqual(['mrl_stops']);
  });

  it('sends NOTHING when the desired set already matches (idempotent re-run)', async () => {
    const client = fakeClient({ mrl_stops: ['1', '2'] });
    const coerced = coerceObjectProperties(OBJ, { mrl_stops: ['2', '1'] }, catalog); // order differs
    const r = await applyObjectWrite(OBJ, 'rec1', coerced, catalog, client);

    expect(puts(client)).toHaveLength(0);
    expect(r.written).toEqual([]);
    expect(r.unchanged).toEqual(['mrl_stops']);
  });

  it('omits an empty add/remove key rather than sending an empty array', async () => {
    const client = fakeClient({ mrl_stops: ['1'] });
    const coerced = coerceObjectProperties(OBJ, { mrl_stops: ['1', '2'] }, catalog);
    await applyObjectWrite(OBJ, 'rec1', coerced, catalog, client);
    expect(puts(client)[0].body.properties.mrl_stops).toEqual({ add: ['2'] }); // no `remove`
  });

  it('migrates a TEXT-era delimited value into the right add set', async () => {
    // The 2026-07-30..08-17 workaround left values as ';'-joined strings.
    const client = fakeClient({ mrl_stops: '1;2' });
    const coerced = coerceObjectProperties(OBJ, { mrl_stops: ['1', '2', '3'] }, catalog);
    await applyObjectWrite(OBJ, 'rec1', coerced, catalog, client);
    expect(puts(client)[0].body.properties.mrl_stops).toEqual({ add: ['3'] });
  });

  it('refuses to write a modifier field when the current value cannot be read', async () => {
    const client = {
      locationId: 'LOC',
      requests: [] as any[],
      async request({ method = 'GET', path, body }: any) {
        this.requests.push({ method, path, body });
        if (method === 'GET') throw new Error('boom');
        return {};
      },
    } as any;
    const coerced = coerceObjectProperties(OBJ, { mrl_stops: ['1'] }, catalog);
    const r = await applyObjectWrite(OBJ, 'rec1', coerced, catalog, client);

    expect(puts(client)).toHaveLength(0); // guessing add/remove could wipe data
    expect(r.written).toEqual([]);
    expect(r.skipped[0].reason).toContain('could not read current value');
  });
});

describe('applyObjectWrite — FILE_UPLOAD modifier', () => {
  it('wraps urls as {add:[{url}]} with no meta (meta 422s)', async () => {
    const client = fakeClient({});
    const coerced = coerceObjectProperties(
      OBJ,
      { resource_logo: { 'ced71d35-1d7a-48fa-89ec-400fa054d091': { meta: { name: 'l.png' }, url: 'https://x.test/l.png' } } },
      catalog,
    );
    await applyObjectWrite(OBJ, 'rec1', coerced, catalog, client);
    expect(puts(client)[0].body.properties.resource_logo).toEqual({ add: [{ url: 'https://x.test/l.png' }] });
  });

  it('is a no-op when the same file is already attached', async () => {
    const client = fakeClient({ resource_logo: [{ url: 'https://x.test/l.png' }] });
    const coerced = coerceObjectProperties(OBJ, { resource_logo: 'https://x.test/l.png' }, catalog);
    const r = await applyObjectWrite(OBJ, 'rec1', coerced, catalog, client);
    expect(puts(client)).toHaveLength(0);
    expect(r.unchanged).toEqual(['resource_logo']);
  });
});

describe('applyObjectWrite — read-back verification (honest reporting)', () => {
  it('reports a 200-but-not-stored write as skipped, not written', async () => {
    const client = fakeClient({}, { storeWrites: false }); // GHL's silent-drop behaviour
    const coerced = coerceObjectProperties(OBJ, { resources: 'Fidelis Engineering' }, catalog);
    const r = await applyObjectWrite(OBJ, 'rec1', coerced, catalog, client);

    expect(r.written).toEqual([]);
    expect(r.skipped[0].key).toBe('resources');
    expect(r.skipped[0].reason).toContain('did not persist');
  });

  it('reports a genuinely stored write as written', async () => {
    const client = fakeClient({});
    const coerced = coerceObjectProperties(OBJ, { resources: 'Fidelis Engineering' }, catalog);
    const r = await applyObjectWrite(OBJ, 'rec1', coerced, catalog, client);
    expect(r.written).toEqual(['resources']);
    expect(r.skipped).toEqual([]);
  });

  it('does not false-alarm on a single-select stored as a KEY after writing a LABEL', async () => {
    // We send "Published"; GHL stores "published". That is success, not a dropped write.
    const client = fakeClient({});
    const coerced = coerceObjectProperties(OBJ, { resource_status: 'Published' }, catalog);
    const r = await applyObjectWrite(OBJ, 'rec1', coerced, catalog, client);
    expect(puts(client)[0].body.properties.resource_status).toBe('Published');
    expect(r.written).toEqual(['resource_status']);
  });
});

describe('didPersist', () => {
  it('compares multi-selects as sets, ignoring order', () => {
    expect(didPersist('MULTIPLE_OPTIONS', ['1', '2'], ['2', '1'])).toBe(true);
    expect(didPersist('MULTIPLE_OPTIONS', ['1', '2'], ['1'])).toBe(false);
    expect(didPersist('MULTIPLE_OPTIONS', ['1'], null)).toBe(false); // the wipe-to-null case
  });

  it('accepts a file url found among the stored files', () => {
    const stored = { 'uuid-a': { url: 'https://x.test/a.png' } };
    expect(didPersist('FILE_UPLOAD', ['https://x.test/a.png'], stored)).toBe(true);
    expect(didPersist('FILE_UPLOAD', ['https://x.test/b.png'], stored)).toBe(false);
  });

  it('treats a DATE read back as YYYY-MM-DD as persisted', () => {
    expect(didPersist('DATE', '2026-08-17T00:00:00Z', '2026-08-17')).toBe(true);
    expect(didPersist('DATE', '2026-08-17T00:00:00Z', null)).toBe(false);
  });

  it('maps a single-select label to its key before comparing', () => {
    const def = catalog[`${OBJ}.resource_status`];
    expect(didPersist('SINGLE_OPTIONS', 'Published', 'published', def)).toBe(true);
    expect(didPersist('SINGLE_OPTIONS', 'Published', 'approved', def)).toBe(false);
  });
});

describe('applyObjectWrite — CHECKBOX uses the same modifier contract', () => {
  const cbCatalog: Record<string, CustomFieldDef> = {
    'business.programs_cb': {
      id: '9', name: 'Programs', fieldKey: 'business.programs_cb', dataType: 'CHECKBOX',
      options: [
        { key: 'local_fellows_program', label: 'LOCAL Fellows Program' },
        { key: 'local_fast_track_to_lending', label: 'LOCAL Fast Track to Lending' },
      ],
    },
  };

  it('diffs to {add,remove} and never sends a plain array or string', async () => {
    const client = fakeClient({ programs_cb: ['local_fellows_program'] });
    const coerced = coerceObjectProperties(
      'business',
      { programs_cb: ['LOCAL Fast Track to Lending'] }, // label in, key out
      cbCatalog,
    );
    const r = await applyObjectWrite('business', 'biz1', coerced, cbCatalog, client);

    expect(puts(client)[0].body.properties.programs_cb).toEqual({
      add: ['local_fast_track_to_lending'],
      remove: ['local_fellows_program'],
    });
    expect(r.written).toEqual(['programs_cb']);
  });

  it('is a no-op when already correct', async () => {
    const client = fakeClient({ programs_cb: ['local_fellows_program'] });
    const coerced = coerceObjectProperties('business', { programs_cb: ['local_fellows_program'] }, cbCatalog);
    const r = await applyObjectWrite('business', 'biz1', coerced, cbCatalog, client);
    expect(puts(client)).toHaveLength(0);
    expect(r.unchanged).toEqual(['programs_cb']);
  });
});

describe('applyObjectWrite — a rejected property must not take down the batch', () => {
  const cat: Record<string, CustomFieldDef> = {
    'business.logo': { id: 'L', name: 'Logo', fieldKey: 'business.logo', dataType: 'FILE_UPLOAD' },
    'business.problem': { id: 'P', name: 'Problem', fieldKey: 'business.problem', dataType: 'TEXT' },
    'business.county': { id: 'C', name: 'County', fieldKey: 'business.county', dataType: 'TEXT' },
  };

  /** GHL rejects the WHOLE body if it contains `poison`, mirroring the live 400 on business.logo:
   *  "We couldn't access the file link for Logo." */
  function pickyClient(poison: string, stored: Record<string, unknown> = {}) {
    const record = { ...stored };
    const requests: Array<{ method: string; body?: any }> = [];
    return {
      requests,
      record,
      locationId: 'LOC',
      async request({ method = 'GET', body }: any) {
        requests.push({ method, body });
        if (method === 'PUT') {
          if (Object.keys(body.properties).includes(poison)) {
            throw new Error(`GHL PUT -> 400: We couldn't access the file link for Logo.`);
          }
          for (const [k, v] of Object.entries(body.properties as Record<string, any>)) record[k] = v;
          return {};
        }
        return { record: { properties: record } };
      },
    } as any;
  }

  it('lands the good fields and reports only the offender as skipped', async () => {
    const client = pickyClient('logo');
    const coerced = coerceObjectProperties(
      'business',
      { logo: 'https://services.leadconnectorhq.com/documents/download/abc', problem: 'We help manufacturers.', county: 'Jackson' },
      cat,
    );
    const r = await applyObjectWrite('business', 'biz1', coerced, cat, client);

    // The unrelated fields must still be written...
    expect(r.written.sort()).toEqual(['county', 'problem']);
    // ...and the failure surfaced rather than being swallowed. A file-link rejection now triggers a
    // re-host attempt (lib/ghl/fileUpload.ts); here the source is unreachable, so it reports that.
    const bad = r.skipped.find((s) => s.key === 'logo');
    expect(bad).toBeDefined();
    expect(bad!.reason).toMatch(/re-host failed|couldn't access the file link/);
    expect(client.record.problem).toBe('We help manufacturers.');
    expect(client.record.logo).toBeUndefined();
  });

  it('does not throw — a poison field is reported, never fatal', async () => {
    const client = pickyClient('logo');
    const coerced = coerceObjectProperties('business', { logo: 'https://x.test/a.png' }, cat);
    // Single-property case: still resolves, still reports.
    const r = await applyObjectWrite('business', 'biz1', coerced, cat, client);
    expect(r.written).toEqual([]);
    expect(r.skipped[0].key).toBe('logo');
  });

  it('costs no extra calls when the batch succeeds', async () => {
    const client = pickyClient('nothing-is-poison');
    const coerced = coerceObjectProperties('business', { problem: 'a', county: 'b' }, cat);
    await applyObjectWrite('business', 'biz1', coerced, cat, client);
    expect(client.requests.filter((r: any) => r.method === 'PUT')).toHaveLength(1);
  });
});


describe('FILE_UPLOAD re-hosting + the provenance guard', () => {
  const cat: Record<string, CustomFieldDef> = {
    'business.logo': { id: 'LOGOFIELD', name: 'Logo', fieldKey: 'business.logo', dataType: 'FILE_UPLOAD' },
  };
  const SOURCE = 'https://services.leadconnectorhq.com/documents/download/31oTZgey';
  const HOSTED = 'https://msgsndr-private.storage.googleapis.com/location/L/custom-Field/LOGOFIELD/abc.png';
  const FILENAME = 'fidelis_logo_color_large.png';

  /** GHL: refuses a documents/download url on attach, accepts a msgsndr-private one, and serves
   *  the upload endpoint. Mirrors the live behaviour that made re-hosting necessary. */
  function ghlLike(stored: Record<string, unknown>) {
    const record: Record<string, unknown> = { ...stored };
    const calls: string[] = [];
    const client = {
      locationId: 'L',
      calls,
      async request({ method = 'GET', path, body }: any) {
        if (String(path).endsWith('/customFields/upload')) {
          calls.push('upload');
          return { uploadedFiles: { fidelisLogoColorLarge: HOSTED }, meta: [{ url: HOSTED, originalname: FILENAME, mimetype: 'image/png' }] };
        }
        if (method === 'PUT') {
          const v: any = body.properties.logo;
          const urls = (v?.add ?? []).map((f: any) => f.url);
          if (urls.some((u: string) => u.includes('documents/download'))) {
            calls.push('put:rejected');
            throw new Error("GHL PUT -> 400: We couldn't access the file link for Logo.");
          }
          calls.push('put:accepted');
          record.logo = urls.map((u: string) => ({ url: u, meta: { originalname: FILENAME } }));
          return {};
        }
        return { record: { properties: record } };
      },
    } as any;
    return { client, calls, record: () => record };
  }

  it('re-hosts a rejected form-upload link and attaches the hosted url instead', async () => {
    const g = ghlLike({});
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } })) as any;
    try {
      const coerced = coerceObjectProperties('business', { logo: { u: { url: SOURCE, meta: { originalname: FILENAME } } } }, cat);
      const r = await applyObjectWrite('business', 'biz1', coerced, cat, g.client);

      expect(g.calls).toEqual(['put:rejected', 'upload', 'put:accepted']);
      expect(r.written).toEqual(['logo']);   // and verification passed against the HOSTED url
      expect(r.skipped).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('THE GUARD: a second run re-uploads nothing, because the name already matches', async () => {
    // The record holds the re-hosted file under its original name; the source url still differs.
    const g = ghlLike({ logo: [{ url: HOSTED, meta: { originalname: FILENAME } }] });
    const coerced = coerceObjectProperties('business', { logo: { u: { url: SOURCE, meta: { originalname: FILENAME } } } }, cat);
    const r = await applyObjectWrite('business', 'biz1', coerced, cat, g.client);

    expect(g.calls).toEqual([]);            // no PUT, no upload — nothing to do
    expect(r.unchanged).toEqual(['logo']);
    expect(r.written).toEqual([]);
  });

  it('does NOT re-host a url GHL already accepts', async () => {
    const g = ghlLike({});
    const coerced = coerceObjectProperties('business', { logo: HOSTED }, cat);
    const r = await applyObjectWrite('business', 'biz1', coerced, cat, g.client);
    expect(g.calls).toEqual(['put:accepted']); // straight through, no upload
    expect(r.written).toEqual(['logo']);
  });
});
