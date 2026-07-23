// Unit tests for sanitizeWixSet — the passthrough of engine-critical gate fields. The load-bearing
// behavior: a key ABSENT from the body must be OMITTED from the input (so saveSet preserves the
// stored value), while an explicit value/null is applied. This is the other half of the fix for the
// 2026-07-21 CMS-flood incident (the store's preserve guardrail is tested in wixStore.test.ts).

import { describe, it, expect } from 'vitest';
import { sanitizeWixSet } from '../wixSanitize';

const base = { name: 'Contact → Team', wixCollectionId: 'Team', matchSourceField: 'id', matchTargetColumn: 'ghlContactId' };

describe('sanitizeWixSet — required fields', () => {
  it('throws when name / collection / match key missing', () => {
    expect(() => sanitizeWixSet({}, 'site')).toThrow(/name is required/);
    expect(() => sanitizeWixSet({ name: 'x' }, 'site')).toThrow(/wixCollectionId/);
    expect(() => sanitizeWixSet({ name: 'x', wixCollectionId: 'Team' }, 'site')).toThrow(/matchSourceField/);
  });

  it('defaults site id, policy, enabled', () => {
    const out = sanitizeWixSet(base, 'default-site');
    expect(out.wixSiteId).toBe('default-site');
    expect(out.policy).toBe('overwrite');
    expect(out.enabled).toBe(true);
  });
});

describe('sanitizeWixSet — omit vs set vs clear (the preserve contract)', () => {
  it('OMITS gate/visibility/writeback/secondaryMatch/createPolicy when the key is absent', () => {
    const out = sanitizeWixSet(base, 'site');
    expect('gate' in out).toBe(false);
    expect('visibility' in out).toBe(false);
    expect('writebackField' in out).toBe(false);
    expect('secondaryMatch' in out).toBe(false);
    expect('createPolicy' in out).toBe(false);
  });

  it('applies an explicit gate and clears with null', () => {
    const set = sanitizeWixSet({ ...base, gate: { field: 'contact.status', actions: { Approved: 'upsert', Hidden: 'hide' }, onPublishSetStatus: 'Published' } }, 'site');
    expect(set.gate).toEqual({ field: 'contact.status', actions: { Approved: 'upsert', Hidden: 'hide' }, onPublishSetStatus: 'Published' });
    const cleared = sanitizeWixSet({ ...base, gate: null }, 'site');
    expect('gate' in cleared).toBe(true);
    expect(cleared.gate).toBeNull();
  });

  it('rejects an invalid gate action', () => {
    expect(() => sanitizeWixSet({ ...base, gate: { field: 'contact.status', actions: { Approved: 'nope' } } }, 'site')).toThrow(/invalid gate action/);
  });

  it('requires gate.field', () => {
    expect(() => sanitizeWixSet({ ...base, gate: { actions: {} } }, 'site')).toThrow(/gate.field is required/);
  });

  it('validates visibility modes', () => {
    expect(sanitizeWixSet({ ...base, visibility: { mode: 'publishState' } }, 'site').visibility).toEqual({ mode: 'publishState' });
    expect(sanitizeWixSet({ ...base, visibility: { mode: 'column', column: 'live', visibleValue: 'yes', hiddenValue: 'no' } }, 'site').visibility)
      .toEqual({ mode: 'column', column: 'live', visibleValue: 'yes', hiddenValue: 'no' });
    expect(() => sanitizeWixSet({ ...base, visibility: { mode: 'bogus' } }, 'site')).toThrow(/visibility.mode/);
    expect(() => sanitizeWixSet({ ...base, visibility: { mode: 'column' } }, 'site')).toThrow(/visibility.column is required/);
  });

  it('normalizes writebackField: value kept, empty/null → null', () => {
    expect(sanitizeWixSet({ ...base, writebackField: 'contact.wix_team_row_id' }, 'site').writebackField).toBe('contact.wix_team_row_id');
    expect(sanitizeWixSet({ ...base, writebackField: '' }, 'site').writebackField).toBeNull();
    expect(sanitizeWixSet({ ...base, writebackField: null }, 'site').writebackField).toBeNull();
  });

  it('drops incomplete secondaryMatch pairs; clears with null', () => {
    const out = sanitizeWixSet({ ...base, secondaryMatch: [{ sourceField: 'email', targetColumn: 'email' }, { sourceField: 'x' }] }, 'site');
    expect(out.secondaryMatch).toEqual([{ sourceField: 'email', targetColumn: 'email' }]);
    expect(sanitizeWixSet({ ...base, secondaryMatch: null }, 'site').secondaryMatch).toBeNull();
  });

  it('validates createPolicy, falling back to find_or_create for junk', () => {
    expect(sanitizeWixSet({ ...base, createPolicy: 'update_only' }, 'site').createPolicy).toBe('update_only');
    expect(sanitizeWixSet({ ...base, createPolicy: 'bogus' }, 'site').createPolicy).toBe('find_or_create');
  });
});
