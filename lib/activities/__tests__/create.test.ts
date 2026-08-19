// createActivity: the record, its associations, and the audit row — the three things v1 got wrong.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture change-log calls instead of hitting the DB.
vi.mock('../../audit/log', () => ({ logChange: vi.fn(async () => {}) }));

import { logChange } from '../../audit/log';
import { createActivity, ActivityValidationError, COMPANY_ACTIVITY_KEY, ACTIVITY_CONTACT_KEY, REFERRED_TO_KEY } from '../create';
import { clearAssociationCache } from '../../ghl/associations';
import { ACTIVITIES_OBJECT } from '../schema';
import type { CustomFieldDef } from '../../ghl/types';

const mockLog = logChange as unknown as ReturnType<typeof vi.fn>;

const defs: CustomFieldDef[] = [
  { id: 'at', name: 'Activity Type', fieldKey: `${ACTIVITIES_OBJECT}.activity_type`, dataType: 'SINGLE_OPTIONS', parentId: 'core',
    options: [{ key: 'technical_assistance', label: 'Technical Assistance' }, { key: 'introduction_referral', label: 'Introduction / Referral' }] },
  { id: 'an', name: 'Activity Name', fieldKey: `${ACTIVITIES_OBJECT}.activity_name`, dataType: 'TEXT', parentId: 'core' },
  { id: 'ad', name: 'Activity Date', fieldKey: `${ACTIVITIES_OBJECT}.activity_date`, dataType: 'DATE', parentId: 'core' },
  { id: 'ao', name: 'Activity Owner', fieldKey: `${ACTIVITIES_OBJECT}.activity_owner`, dataType: 'TEXT', parentId: 'core' },
  { id: 'no', name: 'Activity Notes', fieldKey: `${ACTIVITIES_OBJECT}.activity_notes`, dataType: 'LARGE_TEXT', parentId: 'core' },
  { id: 'rt', name: 'Referral Type', fieldKey: `${ACTIVITIES_OBJECT}.referral_type`, dataType: 'MULTIPLE_OPTIONS', parentId: 'core',
    options: [{ key: 'mentor', label: 'Mentor' }, { key: 'capital_provider', label: 'Capital Provider' }] },
  { id: 'md', name: 'Modality', fieldKey: `${ACTIVITIES_OBJECT}.modality`, dataType: 'SINGLE_OPTIONS', parentId: 'ta',
    options: [{ key: 'one_on_one', label: '1:1' }, { key: 'group', label: 'Group' }] },
  { id: 'st', name: 'Service Topic', fieldKey: `${ACTIVITIES_OBJECT}.service_topic`, dataType: 'SINGLE_OPTIONS', parentId: 'ta',
    options: [{ key: 'coaching', label: 'Coaching' }, { key: 'finance', label: 'Finance' }] },
  { id: 'cn', name: 'Counterparty Name', fieldKey: `${ACTIVITIES_OBJECT}.counterparty_name`, dataType: 'TEXT', parentId: 'ref' },
];

const FOLDERS = [
  { id: 'core', name: 'Activity Info' },
  { id: 'ta', name: 'Technical Assistance' },
  { id: 'ref', name: 'Referral' },
];

const ASSOC_DEFS = [
  { id: 'assoc-company', key: COMPANY_ACTIVITY_KEY, firstObjectKey: 'business', secondObjectKey: ACTIVITIES_OBJECT },
  { id: 'assoc-contact', key: ACTIVITY_CONTACT_KEY, firstObjectKey: 'contact', secondObjectKey: ACTIVITIES_OBJECT },
  { id: 'assoc-referred', key: REFERRED_TO_KEY, firstObjectKey: 'contact', secondObjectKey: ACTIVITIES_OBJECT },
  { id: 'assoc-referred-co', key: 'referral_referred_to_company', firstObjectKey: 'business', secondObjectKey: ACTIVITIES_OBJECT },
  { id: 'assoc-referred-res', key: 'referral_referred_to_resource', firstObjectKey: 'custom_objects.resources', secondObjectKey: ACTIVITIES_OBJECT },
];

interface FakeOpts {
  /** Properties GHL "loses" — accepted with a 200, stored as nothing. */
  drop?: string[];
  /** Association ids whose relation POST fails. */
  failRelation?: string[];
  /** Omit these association definitions from the location. */
  missingAssoc?: string[];
}

function fakeClient(opts: FakeOpts = {}) {
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  let stored: Record<string, unknown> = {};
  const client: any = {
    requests,
    locationId: 'LOC',
    get stored() { return stored; },
    async request({ method = 'GET', path, body }: any) {
      requests.push({ method, path, body });
      if (method === 'POST' && path === `/objects/${ACTIVITIES_OBJECT}/records`) {
        stored = Object.fromEntries(
          Object.entries(body.properties as Record<string, unknown>).filter(([k]) => !(opts.drop ?? []).includes(k)),
        );
        return { record: { id: 'act1', properties: stored } };
      }
      if (method === 'GET' && path === `/objects/${ACTIVITIES_OBJECT}/records/act1`) {
        return { record: { id: 'act1', properties: stored } };
      }
      if (method === 'GET' && path === '/objects/business/records/biz1') {
        return { record: { id: 'biz1', objectKey: 'business', properties: { name: 'Acme Corp' } } };
      }
      if (method === 'GET' && path === '/objects/business/records/missing') return {};
      if (method === 'GET' && path === '/custom-fields/object-key/' + ACTIVITIES_OBJECT) {
        return { fields: defs, folders: FOLDERS };
      }
      if (method === 'GET' && path === '/associations/') {
        return { associations: ASSOC_DEFS.filter((a) => !(opts.missingAssoc ?? []).includes(a.key)) };
      }
      if (method === 'POST' && path === '/associations/relations') {
        if ((opts.failRelation ?? []).includes(body.associationId)) throw new Error('relation rejected');
        return { relation: { id: 'rel' } };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return client;
}

const taInput = {
  type: 'technical_assistance',
  companyId: 'biz1',
  contactIds: ['c1'],
  values: { activity_date: '2026-08-19', modality: 'one_on_one', service_topic: 'coaching', activity_notes: 'Worked on pricing' },
};

const actor = { name: 'Zach Kraabel', email: 'zach@leanrocketlab.org' };

beforeEach(async () => {
  mockLog.mockClear();
  clearAssociationCache();
  const { getCatalog } = await import('../../ghl/catalogCache');
  await getCatalog(ACTIVITIES_OBJECT, { client: fakeClient(), force: true }); // reset the 10-min cache
});

describe('createActivity', () => {
  it('creates the record with the type, a derived name and the actor as owner', async () => {
    const client = fakeClient();
    const res = await createActivity(taInput, { actor, client });

    expect(res.recordId).toBe('act1');
    expect(res.activityName).toBe('Technical Assistance – Acme Corp – 2026-08-19');
    const post = client.requests.find((r: any) => r.method === 'POST' && r.path.endsWith('/records'));
    expect(post.body.properties).toMatchObject({
      activity_name: 'Technical Assistance – Acme Corp – 2026-08-19',
      activity_owner: 'Zach Kraabel',
      activity_notes: 'Worked on pricing',
    });
    // SINGLE_OPTIONS coerce to their label on the objects API.
    expect(post.body.properties.activity_type).toBe('Technical Assistance');
    expect(post.body.properties.modality).toBe('1:1');
    // DATE goes out as full ISO.
    expect(String(post.body.properties.activity_date)).toMatch(/^2026-08-19T/);
  });

  it('links the company always, plus each contact', async () => {
    const client = fakeClient();
    const res = await createActivity(taInput, { actor, client });

    expect(res.links).toEqual([
      { key: COMPANY_ACTIVITY_KEY, recordId: 'biz1', status: 'linked' },
      { key: ACTIVITY_CONTACT_KEY, recordId: 'c1', status: 'linked' },
    ]);
    const rels = client.requests.filter((r: any) => r.path === '/associations/relations');
    // The activity is always the SECOND record; company/contact first.
    expect(rels.map((r: any) => r.body)).toEqual([
      { locationId: 'LOC', associationId: 'assoc-company', firstRecordId: 'biz1', secondRecordId: 'act1' },
      { locationId: 'LOC', associationId: 'assoc-contact', firstRecordId: 'c1', secondRecordId: 'act1' },
    ]);
  });

  it('resolves association ids by key rather than hardcoding them', async () => {
    const client = fakeClient();
    await createActivity(taInput, { actor, client });
    expect(client.requests.some((r: any) => r.path === '/associations/')).toBe(true);
  });

  it('links the referred-to contact on a referral', async () => {
    const client = fakeClient();
    const res = await createActivity(
      {
        type: 'introduction_referral',
        companyId: 'biz1',
        contactIds: ['c1'],
        referredToContactId: 'c2',
        values: { activity_date: '2026-08-19', referral_type: ['capital_provider'], counterparty_name: 'Ann Arbor SPARK' },
      },
      { actor, client },
    );
    expect(res.links.map((l) => [l.key, l.recordId, l.status])).toEqual([
      [COMPANY_ACTIVITY_KEY, 'biz1', 'linked'],
      [ACTIVITY_CONTACT_KEY, 'c1', 'linked'],
      [REFERRED_TO_KEY, 'c2', 'linked'],
    ]);
    // MULTIPLE_OPTIONS at create is a plain array of option KEYS (the modifier is an update rule).
    const post = client.requests.find((r: any) => r.method === 'POST' && r.path.endsWith('/records'));
    expect(post.body.properties.referral_type).toEqual(['capital_provider']);
  });

  it('reports a failed company link instead of reporting success', async () => {
    const client = fakeClient({ failRelation: ['assoc-company'] });
    const res = await createActivity(taInput, { actor, client });
    expect(res.links[0]).toMatchObject({ key: COMPANY_ACTIVITY_KEY, status: 'failed', reason: 'relation rejected' });
    expect(mockLog.mock.calls[0][0].error).toContain(COMPANY_ACTIVITY_KEY);
  });

  it('reports a missing association definition rather than guessing an id', async () => {
    const client = fakeClient({ missingAssoc: [COMPANY_ACTIVITY_KEY] });
    const res = await createActivity(taInput, { actor, client });
    expect(res.links[0].status).toBe('failed');
    expect(res.links[0].reason).toContain('no association definition');
  });

  it('reports a field GHL accepted but did not store as skipped, not written', async () => {
    const client = fakeClient({ drop: ['activity_notes'] });
    const res = await createActivity(taInput, { actor, client });
    expect(res.written).not.toContain('activity_notes');
    expect(res.skipped.find((s) => s.key === 'activity_notes')?.reason).toMatch(/did not persist/);
  });

  it('writes one staff-attributed change-log row naming the record and its links', async () => {
    const client = fakeClient();
    await createActivity(taInput, { actor, client });

    expect(mockLog).toHaveBeenCalledTimes(1);
    const ev = mockLog.mock.calls[0][0];
    expect(ev).toMatchObject({
      objectType: ACTIVITIES_OBJECT,
      recordId: 'act1',
      recordLabel: 'Technical Assistance – Acme Corp – 2026-08-19',
      actorKind: 'staff',
      actorName: 'Zach Kraabel',
      action: 'create',
      method: 'Technical Assistance',
    });
    expect(ev.error).toBeUndefined();
    const fieldNames = ev.changes.map((c: any) => c.field);
    expect(fieldNames).toContain(`${ACTIVITIES_OBJECT}.modality`);
    expect(fieldNames).toContain(`association.${COMPANY_ACTIVITY_KEY}`);
    expect(fieldNames).toContain(`association.${ACTIVITY_CONTACT_KEY}`);
  });

  it('falls back to the actor email, then to "staff", for attribution', async () => {
    const client = fakeClient();
    await createActivity(taInput, { actor: { email: 'zach@leanrocketlab.org' }, client });
    expect(mockLog.mock.calls[0][0].actorName).toBe('zach@leanrocketlab.org');

    mockLog.mockClear();
    await createActivity(taInput, { client });
    expect(mockLog.mock.calls[0][0].actorName).toBe('staff');
  });

  it('keeps an explicit activity_name and owner over the derived ones', async () => {
    const client = fakeClient();
    const res = await createActivity(
      { ...taInput, values: { ...taInput.values, activity_name: 'Pricing workshop follow-up', activity_owner: 'Emmett Barrett' } },
      { actor, client },
    );
    expect(res.activityName).toBe('Pricing workshop follow-up');
    const post = client.requests.find((r: any) => r.method === 'POST' && r.path.endsWith('/records'));
    expect(post.body.properties.activity_owner).toBe('Emmett Barrett');
  });

  it('links a referred-to COMPANY and RESOURCE, not just a contact', async () => {
    // Participants and counterparties are different links: reporting counts participants, which is
    // why a service provider can appear here without ever entering a "companies served" count.
    const client = fakeClient();
    const res = await createActivity(
      {
        type: 'introduction_referral',
        companyId: 'biz1',
        contactIds: ['c1'],
        referredTo: [
          { kind: 'Resource', recordId: 'res9' },
          { kind: 'Company', recordId: 'biz-provider' },
        ],
        values: { activity_date: '2026-08-19', referral_type: ['mentor'], counterparty_name: 'Fidelis' },
      },
      { actor, client },
    );
    expect(res.links.map((l) => [l.key, l.recordId, l.status])).toEqual([
      [COMPANY_ACTIVITY_KEY, 'biz1', 'linked'],
      [ACTIVITY_CONTACT_KEY, 'c1', 'linked'],
      ['referral_referred_to_resource', 'res9', 'linked'],
      ['referral_referred_to_company', 'biz-provider', 'linked'],
    ]);
  });

  it('does not link the same counterparty twice', async () => {
    const client = fakeClient();
    const res = await createActivity(
      {
        type: 'introduction_referral',
        companyId: 'biz1',
        contactIds: [],
        referredTo: [{ kind: 'Contact', recordId: 'c2' }],
        referredToContactId: 'c2', // legacy shorthand for the same person
        values: { activity_date: '2026-08-19', referral_type: ['mentor'], counterparty_name: 'Ann' },
      },
      { actor, client },
    );
    expect(res.links.filter((l) => l.recordId === 'c2')).toHaveLength(1);
  });

  it('refuses an incomplete input before writing anything', async () => {
    const client = fakeClient();
    await expect(
      createActivity({ type: 'technical_assistance', companyId: 'biz1', values: { activity_date: '2026-08-19' } }, { actor, client }),
    ).rejects.toBeInstanceOf(ActivityValidationError);
    expect(client.requests.some((r: any) => r.method === 'POST')).toBe(false);
    expect(mockLog).not.toHaveBeenCalled();
  });

  it('refuses a company that does not exist', async () => {
    const client = fakeClient();
    await expect(createActivity({ ...taInput, companyId: 'missing' }, { actor, client })).rejects.toThrow(/not found/);
    expect(client.requests.some((r: any) => r.method === 'POST')).toBe(false);
  });
});
