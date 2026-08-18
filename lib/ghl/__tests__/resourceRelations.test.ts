import { describe, it, expect } from 'vitest';
import {
  ensureResourceCompanyLink,
  websiteDomain,
  domainsDisagree,
  RESOURCE_COMPANY_ASSOCIATION_ID,
  RESOURCE_CONTACT_ASSOCIATION_ID,
} from '../resourceRelations';

const RESOURCE_ID = 'res1';
const COMPANY_ID = '6a4d574f4ebee4d821b49f16';
const CONTACT_ID = 'cont1';

/**
 * Fake GHL client. `relations` is what the relations read returns, `contact` the linked contact,
 * `companyWebsite`/`resourceWebsite` drive the domain confidence check.
 */
function fakeClient(o: {
  relations?: any[];
  contact?: any;
  resourceWebsite?: string;
  companyWebsite?: string;
  relationError?: Error;
}) {
  const posts: any[] = [];
  const client: any = {
    locationId: 'LOC',
    posts,
    async request({ method = 'GET', path, body }: any) {
      if (method === 'POST' && path === '/associations/relations') {
        if (o.relationError) throw o.relationError;
        posts.push(body);
        return {};
      }
      if (path.startsWith('/associations/relations/')) return { relations: o.relations ?? [] };
      if (path.startsWith('/contacts/')) return { contact: o.contact ?? null };
      if (path.includes('/objects/custom_objects.resources/records/')) {
        return { record: { properties: { website: o.resourceWebsite } } };
      }
      if (path.includes('/objects/business/records/')) {
        return { record: { properties: { website: o.companyWebsite } } };
      }
      return {};
    },
  };
  return client;
}

const contactRelation = { associationId: RESOURCE_CONTACT_ASSOCIATION_ID, firstRecordId: CONTACT_ID, secondRecordId: RESOURCE_ID };
const companyRelation = { associationId: RESOURCE_COMPANY_ASSOCIATION_ID, firstRecordId: COMPANY_ID, secondRecordId: RESOURCE_ID };

describe('ensureResourceCompanyLink', () => {
  it('links via the matched contact businessId, company FIRST and resource SECOND', async () => {
    const client = fakeClient({
      relations: [contactRelation],
      contact: { id: CONTACT_ID, businessId: COMPANY_ID },
    });
    const r = await ensureResourceCompanyLink(RESOURCE_ID, { apply: true, client });

    expect(r.status).toBe('linked');
    expect(r.via).toBe('contact-businessId');
    expect(r.companyId).toBe(COMPANY_ID);
    expect(client.posts).toHaveLength(1);
    expect(client.posts[0]).toMatchObject({
      associationId: RESOURCE_COMPANY_ASSOCIATION_ID,
      firstRecordId: COMPANY_ID,   // business first
      secondRecordId: RESOURCE_ID, // resource second
    });
  });

  it('is idempotent: an existing company relation writes nothing', async () => {
    const client = fakeClient({ relations: [contactRelation, companyRelation] });
    const r = await ensureResourceCompanyLink(RESOURCE_ID, { apply: true, client });

    expect(r.status).toBe('already-linked');
    expect(client.posts).toHaveLength(0);
  });

  it('treats a duplicate-relation error as already-linked (the relations read is unreliable)', async () => {
    const client = fakeClient({
      relations: [contactRelation],
      contact: { id: CONTACT_ID, businessId: COMPANY_ID },
      relationError: new Error('Relation already exists'),
    });
    const r = await ensureResourceCompanyLink(RESOURCE_ID, { apply: true, client });
    expect(r.status).toBe('already-linked');
  });

  it('dry-run reports the link it would make without writing', async () => {
    const client = fakeClient({
      relations: [contactRelation],
      contact: { id: CONTACT_ID, businessId: COMPANY_ID },
    });
    const r = await ensureResourceCompanyLink(RESOURCE_ID, { apply: false, client });

    expect(r.status).toBe('linked');
    expect(r.applied).toBe(false);
    expect(client.posts).toHaveLength(0);
  });

  it('needs review when the resource has no contact relation at all', async () => {
    // The 90 originally-imported resources are in this state.
    const client = fakeClient({ relations: [] });
    const r = await ensureResourceCompanyLink(RESOURCE_ID, { apply: true, client });

    expect(r.status).toBe('needs-review');
    expect(r.note).toContain('no contact relation');
    expect(client.posts).toHaveLength(0);
  });

  it('needs review — never invents a company — when the contact has neither businessId nor company name', async () => {
    const client = fakeClient({ relations: [contactRelation], contact: { id: CONTACT_ID } });
    const r = await ensureResourceCompanyLink(RESOURCE_ID, { apply: true, client });

    expect(r.status).toBe('needs-review');
    expect(client.posts).toHaveLength(0);
  });

  it('flags a website-domain disagreement but still links', async () => {
    // The realistic failure mode: a partner staffer submitting on behalf of another org.
    const client = fakeClient({
      relations: [contactRelation],
      contact: { id: CONTACT_ID, businessId: COMPANY_ID },
      resourceWebsite: 'https://someoneelse.com',
      companyWebsite: 'https://www.agilegrowthshop.com',
    });
    const r = await ensureResourceCompanyLink(RESOURCE_ID, { apply: true, client });

    expect(r.status).toBe('linked');
    expect(r.domainMismatch).toEqual({ resource: 'someoneelse.com', company: 'agilegrowthshop.com' });
    expect(client.posts).toHaveLength(1); // linked anyway
  });

  it('does not flag when the domains agree apart from www/scheme', async () => {
    const client = fakeClient({
      relations: [contactRelation],
      contact: { id: CONTACT_ID, businessId: COMPANY_ID },
      resourceWebsite: 'agilegrowthshop.com',
      companyWebsite: 'https://www.agilegrowthshop.com/',
    });
    const r = await ensureResourceCompanyLink(RESOURCE_ID, { apply: true, client });
    expect(r.domainMismatch).toBeUndefined();
  });

  it('reports an error (not a link) when relations cannot be read', async () => {
    const client: any = { locationId: 'L', async request() { throw new Error('boom'); } };
    const r = await ensureResourceCompanyLink(RESOURCE_ID, { apply: true, client });
    expect(r.status).toBe('error');
  });
});

describe('websiteDomain / domainsDisagree', () => {
  it('normalizes scheme, www and trailing slash', () => {
    expect(websiteDomain('https://www.Example.com/path')).toBe('example.com');
    expect(websiteDomain('example.com')).toBe('example.com');
    expect(websiteDomain('')).toBeNull();
    expect(websiteDomain(null)).toBeNull();
  });

  it('an unknown domain on either side is never a disagreement', () => {
    expect(domainsDisagree('a.com', 'b.com')).toBe(true);
    expect(domainsDisagree('a.com', null)).toBe(false);
    expect(domainsDisagree(null, 'b.com')).toBe(false);
    expect(domainsDisagree('a.com', 'https://www.a.com')).toBe(false);
  });
});
