import { describe, it, expect, vi } from 'vitest';
import { normalizeName, normalizeLaraId } from '../normalize';
import { extractLaraId, toCompanyKey, scanDuplicates } from '../scan';
import { createOrMatchByLaraId, CompanyIndex } from '../engine';
import type { BusinessListItem } from '../../ghl/types';
import type { CompanyKey } from '../types';

describe('normalizeName', () => {
  it('strips punctuation + legal suffix + dba tail', () => {
    expect(normalizeName('Acme Robotics, LLC')).toBe('acme robotics');
    expect(normalizeName('Foo Inc.')).toBe('foo');
    expect(normalizeName('Bailey & Friends')).toBe('bailey and friends');
    expect(normalizeName('Abba Industries (dba Abba Ginger)')).toBe('abba industries');
    expect(normalizeName('20Fathoms')).toBe('20fathoms');
  });
});

describe('normalizeLaraId', () => {
  it('numeric compared as integer (drops leading zeros)', () => {
    expect(normalizeLaraId(123456)).toBe('123456');
    expect(normalizeLaraId('00123')).toBe('123');
  });
  it('blank / n/a -> null', () => {
    expect(normalizeLaraId('')).toBeNull();
    expect(normalizeLaraId('N/A')).toBeNull();
    expect(normalizeLaraId(null)).toBeNull();
  });
});

describe('extractLaraId', () => {
  it('reads lara_id from legacy list customFields (valueNumber or valueString)', () => {
    const a: BusinessListItem = { id: '1', name: 'A', customFields: [{ key: 'lara_id', valueNumber: 123456 }] };
    const b: BusinessListItem = { id: '2', name: 'B', customFields: [{ key: 'lara_id', valueString: '00777' }] };
    const c: BusinessListItem = { id: '3', name: 'C', customFields: [] };
    expect(extractLaraId(a)).toBe('123456');
    expect(extractLaraId(b)).toBe('777');
    expect(extractLaraId(c)).toBeNull();
  });
});

describe('scanDuplicates', () => {
  const items: BusinessListItem[] = [
    { id: '1', name: 'Acme Robotics LLC', customFields: [{ key: 'lara_id', valueNumber: 100 }] },
    { id: '2', name: 'Acme Robotics', customFields: [{ key: 'lara_id', valueNumber: 100 }] }, // same LARA -> merge
    { id: '3', name: 'Beta Foods', customFields: [] },
    { id: '4', name: 'Beta Foods Inc', customFields: [] }, // same name, no LARA -> review
    { id: '5', name: 'Gamma Co', customFields: [{ key: 'lara_id', valueNumber: 200 }] },
  ];
  const report = scanDuplicates(items.map(toCompanyKey));

  it('groups exact LARA duplicates as merge', () => {
    expect(report.exactDuplicates).toHaveLength(1);
    expect(report.exactDuplicates[0]).toMatchObject({ keyType: 'lara', key: '100', action: 'merge' });
    expect(report.exactDuplicates[0].companies.map((c) => c.id).sort()).toEqual(['1', '2']);
  });
  it('flags name-only duplicates as review (not the LARA group)', () => {
    const names = report.nameCandidates;
    expect(names.some((g) => g.key === 'beta foods' && g.action === 'review')).toBe(true);
    expect(names.some((g) => g.key === 'acme robotics')).toBe(false); // already an exact dup
  });
  it('counts missing LARA ids', () => {
    expect(report.withLaraId).toBe(3);
    expect(report.missingLaraId).toBe(2);
  });
});

function idx(keys: CompanyKey[]): CompanyIndex {
  const byLara = new Map<string, string[]>(); const byName = new Map<string, string[]>();
  for (const k of keys) {
    if (k.laraId) byLara.set(k.laraId, [...(byLara.get(k.laraId) ?? []), k.id]);
    if (k.normName) byName.set(k.normName, [...(byName.get(k.normName) ?? []), k.id]);
  }
  return { keys, byLara, byName };
}

describe('createOrMatchByLaraId', () => {
  const index = idx([
    { id: 'co100', name: 'Acme Robotics LLC', laraId: '100', normName: 'acme robotics' },
    { id: 'coNoLara', name: 'Zeta Widgets', laraId: null, normName: 'zeta widgets' },
  ]);

  it('matches an existing company by LARA id (no create)', async () => {
    const create = vi.fn(async () => 'NEW');
    const r = await createOrMatchByLaraId({ laraId: '00100', name: 'Acme', create }, index);
    expect(r).toMatchObject({ status: 'matched', companyId: 'co100', laraId: '100' });
    expect(create).not.toHaveBeenCalled();
  });

  it('creates when LARA id is new', async () => {
    const create = vi.fn(async () => 'NEW');
    const r = await createOrMatchByLaraId({ laraId: '999', name: 'New Co', create }, index);
    expect(r.status).toBe('created');
    expect(create).toHaveBeenCalledOnce();
  });

  it('flags ambiguous when no LARA id but the name matches (no create)', async () => {
    const create = vi.fn(async () => 'NEW');
    const r = await createOrMatchByLaraId({ name: 'Zeta Widgets', create }, index);
    expect(r.status).toBe('ambiguous');
    expect(r.candidates).toEqual(['coNoLara']);
    expect(create).not.toHaveBeenCalled();
  });

  it('creates (flagged) when no LARA id and no name match', async () => {
    const create = vi.fn(async () => 'NEW');
    const r = await createOrMatchByLaraId({ name: 'Totally Unique Startup', create }, index);
    expect(r.status).toBe('created');
    expect(r.laraId).toBeNull();
    expect(create).toHaveBeenCalledOnce();
  });
});
