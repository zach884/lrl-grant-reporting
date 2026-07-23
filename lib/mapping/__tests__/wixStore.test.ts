// Regression test for the saveSet PRESERVE guardrail (the 2026-07-21 CMS-flood fix), exercised
// through the pure resolveWixPreservable helper so no live DB is needed. The contract: a field the
// caller doesn't send (undefined) is KEPT from the stored row; an explicit null CLEARS it; a value
// overwrites. Without this, a rows-only UI save nulled the status gate → find_or_create upserted
// every contact and created 1,391 junk rows.

import { describe, it, expect } from 'vitest';
import { resolveWixPreservable } from '../wixStore';
import type { WixMappingSetRow } from '../../db/schema';
import type { WixGate, WixVisibility } from '../wixTypes';

const gate: WixGate = { field: 'contact.status', actions: { Approved: 'upsert', Published: 'update', Hidden: 'hide' }, onPublishSetStatus: 'Published' };
const visibility: WixVisibility = { mode: 'publishState' };

function existing(overrides: Partial<WixMappingSetRow> = {}): WixMappingSetRow {
  return {
    createPolicy: 'find_or_create',
    gate,
    secondaryMatch: [{ sourceField: 'email', targetColumn: 'email' }],
    writebackField: 'contact.wix_team_row_id',
    visibility,
    ...overrides,
  } as WixMappingSetRow;
}

describe('resolveWixPreservable', () => {
  it('PRESERVES every field when the input omits them (the rows-only save path)', () => {
    const out = resolveWixPreservable(existing(), {}); // no gate/visibility/etc. — like a rows-only save
    expect(out.gate).toEqual(gate);
    expect(out.visibility).toEqual(visibility);
    expect(out.writebackField).toBe('contact.wix_team_row_id');
    expect(out.secondaryMatch).toEqual([{ sourceField: 'email', targetColumn: 'email' }]);
    expect(out.createPolicy).toBe('find_or_create');
  });

  it('SETS fields when the input provides them', () => {
    const newGate: WixGate = { field: 'contact.stage', actions: { Live: 'upsert' } };
    const out = resolveWixPreservable(existing(), { gate: newGate, createPolicy: 'update_only', writebackField: 'contact.other' });
    expect(out.gate).toEqual(newGate);
    expect(out.createPolicy).toBe('update_only');
    expect(out.writebackField).toBe('contact.other');
    // untouched fields still preserved
    expect(out.visibility).toEqual(visibility);
  });

  it('CLEARS fields on an explicit null (a real gate editor clearing them)', () => {
    const out = resolveWixPreservable(existing(), { gate: null, visibility: null, writebackField: null, secondaryMatch: null });
    expect(out.gate).toBeNull();
    expect(out.visibility).toBeNull();
    expect(out.writebackField).toBeNull();
    expect(out.secondaryMatch).toBeNull();
  });

  it('defaults createPolicy to find_or_create when neither side has it', () => {
    expect(resolveWixPreservable(existing({ createPolicy: null as any }), {}).createPolicy).toBe('find_or_create');
  });
});
