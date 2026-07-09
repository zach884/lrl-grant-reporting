// Unit tests for the DB store's row -> FieldMapping conversion. These guard the contract
// the sync engine depends on (tri-state `enabled`, optional keys collapse to undefined,
// holdValues/transform round-trip). No live DB needed — pure mapping logic.

import { describe, it, expect } from 'vitest';
import { rowToMapping } from '../dbStore';
import type { FieldMappingRow } from '@/lib/db/schema';

function row(overrides: Partial<FieldMappingRow>): FieldMappingRow {
  return {
    id: 'x',
    syncId: 's',
    contactKey: 'contact.naics_code',
    businessKey: 'business.naics_code',
    direction: 'both',
    mirrorDown: false,
    enabled: null,
    note: null,
    holdValues: null,
    transform: null,
    sortOrder: 0,
    ...overrides,
  } as FieldMappingRow;
}

describe('rowToMapping', () => {
  it('collapses null enabled to undefined (tri-state = enabled)', () => {
    const m = rowToMapping(row({ enabled: null }));
    expect('enabled' in m).toBe(false);
  });

  it('preserves enabled=false so a row is kept but not synced', () => {
    const m = rowToMapping(row({ enabled: false }));
    expect(m.enabled).toBe(false);
  });

  it('keeps enabled=true explicitly', () => {
    expect(rowToMapping(row({ enabled: true })).enabled).toBe(true);
  });

  it('omits empty/null note and empty holdValues', () => {
    const m = rowToMapping(row({ note: '', holdValues: [] }));
    expect('note' in m).toBe(false);
    expect('holdValues' in m).toBe(false);
  });

  it('round-trips note, holdValues, and transform when present', () => {
    const m = rowToMapping(row({ note: 'why', holdValues: ['Other'], transform: 'countryCode' }));
    expect(m.note).toBe('why');
    expect(m.holdValues).toEqual(['Other']);
    expect(m.transform).toBe('countryCode');
  });

  it('carries the core keys and direction', () => {
    const m = rowToMapping(row({ contactKey: 'address1', businessKey: 'business.address', direction: 'up' }));
    expect(m).toMatchObject({ contactKey: 'address1', businessKey: 'business.address', direction: 'up', mirrorDown: false });
  });
});
