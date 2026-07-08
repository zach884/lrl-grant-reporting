import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Contact, CustomFieldCatalog } from '../../ghl/types';
import type { CompanySyncResult } from '../types';

// Mock the per-company sync so we exercise ONLY the reconcile orchestration
// (pool / checkpoint / limit / report). syncCompanyDown itself is covered by downsync tests.
const calls: string[] = [];
vi.mock('../downsync', () => ({
  syncCompanyDown: vi.fn(async (companyId: string, _m: any, _c: any, opts: any): Promise<CompanySyncResult> => {
    calls.push(companyId);
    if (companyId === 'cERR') throw new Error('429: simulated rate limit');
    const contacts: Contact[] = opts.contacts ?? [];
    const results = contacts.map((c, i) => ({
      contactId: c.id,
      written: companyId === 'c2' ? [] : (i === 0 ? ['fld1'] : []),
      companyNameWritten: false,
      unchanged: 1,
      skipped: [],
      drift: companyId === 'c2' ? [] : (i === 0 ? [{ field: 'fld1', from: 'a', to: 'b' }] : []),
      applied: !!opts.apply,
    }));
    return { companyId, companyName: `Co ${companyId}`, contactCount: contacts.length, results };
  }),
}));

import { reconcileAll, writeReconcileReport, ReconcileCheckpoint } from '../reconcile';

const catalogs = { business: { byKey: {} } as CustomFieldCatalog, contact: { byKey: {} } as CustomFieldCatalog };
const client = {} as any;

// c1: 2 contacts (1 writes), c2: 1 contact (no writes), c3: 1 contact (writes)
const contacts: Contact[] = [
  { id: 'a1', businessId: 'c1' } as Contact,
  { id: 'a2', businessId: 'c1' } as Contact,
  { id: 'b1', businessId: 'c2' } as Contact,
  { id: 'd1', businessId: 'c3' } as Contact,
  { id: 'x1' } as Contact, // unlinked -> ignored
];

class MemCheckpoint implements ReconcileCheckpoint {
  done = new Set<string>();
  marked: string[] = [];
  constructor(pre: string[] = []) { pre.forEach((x) => this.done.add(x)); }
  async loadDone() { return new Set(this.done); }
  async markDone(id: string) { this.marked.push(id); }
}

beforeEach(() => { calls.length = 0; });

describe('reconcileAll orchestration', () => {
  it('processes every linked company, aggregates stats, and reports only changed ones', async () => {
    const rep = await reconcileAll([], catalogs, { apply: false, client, contacts });
    expect(rep.stats.companiesProcessed).toBe(3);
    expect(rep.stats.contactsProcessed).toBe(4);
    expect(rep.stats.contactsChanged).toBe(2); // one in c1, one in c3
    expect(rep.stats.fieldsWritten).toBe(2);
    expect(rep.changed.map((c) => c.companyId).sort()).toEqual(['c1', 'c3']);
    expect(rep.run.companiesTotal).toBe(3);
    expect(rep.run.apply).toBe(false);
  });

  it('honors limit (staged first pass)', async () => {
    const rep = await reconcileAll([], catalogs, { apply: false, client, contacts, limit: 2 });
    expect(rep.stats.companiesProcessed).toBe(2);
  });

  it('skips checkpointed companies and marks each processed one', async () => {
    const cp = new MemCheckpoint(['c1']);
    const rep = await reconcileAll([], catalogs, { apply: false, client, contacts, checkpoint: cp });
    expect(rep.run.companiesSkipped).toBe(1);
    expect(rep.stats.companiesProcessed).toBe(2);
    expect(calls.sort()).toEqual(['c2', 'c3']);
    expect(cp.marked.sort()).toEqual(['c2', 'c3']);
  });

  it('produces identical stats under concurrency', async () => {
    const rep = await reconcileAll([], catalogs, { apply: false, client, contacts, concurrency: 3 });
    expect(rep.stats.companiesProcessed).toBe(3);
    expect(rep.stats.fieldsWritten).toBe(2);
    expect(rep.run.concurrency).toBe(3);
  });

  it('does NOT checkpoint a company that errored (must retry on resume)', async () => {
    const cp = new MemCheckpoint();
    const withErr: Contact[] = [...contacts, { id: 'e1', businessId: 'cERR' } as Contact];
    const rep = await reconcileAll([], catalogs, { apply: true, client, contacts: withErr, checkpoint: cp });
    expect(rep.stats.errors.some((e) => e.companyId === 'cERR')).toBe(true);
    expect(cp.marked).not.toContain('cERR');
    expect(cp.marked.sort()).toEqual(['c1', 'c2', 'c3']);
  });

  it('renders a human summary with drift count', async () => {
    const rep = await reconcileAll([], catalogs, { apply: false, client, contacts });
    const summary = await writeReconcileReport(rep);
    expect(summary).toContain('DRY-RUN');
    expect(summary).toContain('companies: 3 processed');
    expect(summary).toContain('would write');
  });
});
