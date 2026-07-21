import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture writes instead of hitting GHL.
vi.mock('../../ghl/writeRecord', () => ({ writeRecordFields: vi.fn(async () => ({ written: [], skipped: [] })) }));

import { writeRecordFields } from '../../ghl/writeRecord';
import { applyContactProposals, readContactField } from '../contactEngine';
import type { ContactEnrichmentProposal } from '../types';
import type { Contact, CustomFieldCatalog, CustomFieldDef } from '../../ghl/types';

const mockWrite = writeRecordFields as unknown as ReturnType<typeof vi.fn>;

function makeCatalog(keys: string[]): CustomFieldCatalog {
  const defs: CustomFieldDef[] = keys.map((key, i) => ({ id: `id_${i}`, name: key, fieldKey: key, dataType: 'MULTIPLE_OPTIONS' }));
  const byKey: Record<string, CustomFieldDef> = {};
  const byId: Record<string, CustomFieldDef> = {};
  for (const d of defs) { byKey[d.fieldKey] = d; byId[d.id] = d; }
  return { fields: defs, folders: [], byKey, byId };
}

function contactWith(catalog: CustomFieldCatalog, values: Record<string, unknown>): Contact {
  return {
    id: 'c1',
    customFields: Object.entries(values).map(([k, v]) => ({ id: catalog.byKey[k].id, value: v })),
  };
}

const prov = { source: 'anthropic', method: 'ai' as const, confidence: 0.9, timestamp: 't' };
const fakeClient = {} as any; // passed so the engine doesn't construct a live GhlClient

beforeEach(() => mockWrite.mockClear());

describe('applyContactProposals', () => {
  const catalog = makeCatalog(['contact.service_areas', 'contact.mrl_stops']);

  it('writes a changed value in overwrite mode', async () => {
    const contact = contactWith(catalog, { 'contact.service_areas': ['Old'] });
    const proposals: ContactEnrichmentProposal[] = [
      { contactKey: 'contact.service_areas', value: ['Go-to-Market Strategy'], provenance: prov },
    ];
    const res = await applyContactProposals('c1', contact, proposals, catalog, { mode: 'overwrite' }, { apply: true, client: fakeClient });
    expect(res.applied.map((a) => a.contactKey)).toEqual(['contact.service_areas']);
    expect(res.didWrite).toBe(true);
    expect(mockWrite).toHaveBeenCalledWith('contact', 'c1', { 'contact.service_areas': ['Go-to-Market Strategy'] }, catalog, fakeClient);
  });

  it('is idempotent — an unchanged value (order-insensitive) is skipped', async () => {
    const contact = contactWith(catalog, { 'contact.mrl_stops': ['5', '6'] });
    const proposals: ContactEnrichmentProposal[] = [
      { contactKey: 'contact.mrl_stops', value: ['6', '5'], provenance: prov },
    ];
    const res = await applyContactProposals('c1', contact, proposals, catalog, { mode: 'overwrite' }, { apply: true, client: fakeClient });
    expect(res.applied).toEqual([]);
    expect(res.skipped[0].reason).toBe('already up to date');
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('fill-empty leaves an already-populated field alone', async () => {
    const contact = contactWith(catalog, { 'contact.service_areas': ['Existing'] });
    const proposals: ContactEnrichmentProposal[] = [
      { contactKey: 'contact.service_areas', value: ['New'], provenance: prov },
    ];
    const res = await applyContactProposals('c1', contact, proposals, catalog, { mode: 'fill-empty' }, { apply: true, client: fakeClient });
    expect(res.skipped[0].reason).toBe('already set (fill-empty)');
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('dry-run computes applied but does not write', async () => {
    const contact = contactWith(catalog, {});
    const proposals: ContactEnrichmentProposal[] = [
      { contactKey: 'contact.service_areas', value: ['New'], provenance: prov },
    ];
    const res = await applyContactProposals('c1', contact, proposals, catalog, { mode: 'overwrite' }, { apply: false });
    expect(res.applied).toHaveLength(1);
    expect(res.didWrite).toBe(false);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('drops proposals below minConfidence and for unknown fields', async () => {
    const contact = contactWith(catalog, {});
    const proposals: ContactEnrichmentProposal[] = [
      { contactKey: 'contact.service_areas', value: ['A'], provenance: { ...prov, confidence: 0.1 } },
      { contactKey: 'contact.not_a_field', value: ['B'], provenance: prov },
    ];
    const res = await applyContactProposals('c1', contact, proposals, catalog, { mode: 'overwrite', minConfidence: 0.5 }, { apply: true, client: fakeClient });
    expect(res.applied).toEqual([]);
    const reasons = res.skipped.map((s) => s.reason);
    expect(reasons.some((r) => r.includes('below min confidence'))).toBe(true);
    expect(reasons.some((r) => r.includes('not in contact catalog'))).toBe(true);
  });
});

describe('readContactField', () => {
  const catalog = makeCatalog(['contact.mrl_stops']);
  it('reads scalars and custom fields; undefined for unknown', () => {
    const contact: Contact = { id: 'c1', firstName: 'A', lastName: 'B', customFields: [{ id: catalog.byKey['contact.mrl_stops'].id, value: ['3'] }] };
    expect(readContactField(contact, catalog, 'fullName')).toBe('A B');
    expect(readContactField(contact, catalog, 'contact.mrl_stops')).toEqual(['3']);
    expect(readContactField(contact, catalog, 'contact.nope')).toBeUndefined();
  });
});
