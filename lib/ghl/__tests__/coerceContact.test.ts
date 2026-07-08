import { describe, it, expect } from 'vitest';
import { coerceContactCustomFields, toTextboxListValue } from '../coerceContact';
import type { CustomFieldCatalog, CustomFieldDef } from '../types';

function cat(fields: CustomFieldDef[]): CustomFieldCatalog {
  const byKey: Record<string, CustomFieldDef> = {};
  const byId: Record<string, CustomFieldDef> = {};
  for (const f of fields) { byKey[f.fieldKey] = f; byId[f.id] = f; }
  return { fields, folders: [], byKey, byId };
}

const catalog = cat([
  { id: 'ms', name: 'Programs', fieldKey: 'contact.programs', dataType: 'MULTIPLE_OPTIONS',
    options: [{ key: 'local', label: 'Local' }, { key: 'i40', label: 'i4.0 Accelerator' }] },
  { id: 'tbl', name: 'Milestones', fieldKey: 'contact.milestones', dataType: 'TEXTBOX_LIST',
    rows: [{ id: 'r1', label: 'Milestone 1' }, { id: 'r2', label: 'Milestone 2' }] },
  { id: 'file', name: 'Headshot', fieldKey: 'contact.headshot', dataType: 'FILE_UPLOAD' },
  { id: 'sel', name: 'Stage', fieldKey: 'contact.stage', dataType: 'SINGLE_OPTIONS',
    options: [{ key: 'seed', label: 'Seed' }] },
]);

describe('coerceContactCustomFields', () => {
  it('multi-select -> array of exact labels (from labels or keys)', () => {
    const { fields } = coerceContactCustomFields({ 'contact.programs': ['Local', 'i40'] }, catalog);
    expect(fields).toContainEqual({ id: 'ms', value: ['Local', 'i4.0 Accelerator'] });
  });

  it('textbox-list -> object keyed by row id (accepts label keys or positional array)', () => {
    const byLabel = coerceContactCustomFields({ 'contact.milestones': { 'Milestone 1': 'Hit $1M' } }, catalog);
    expect(byLabel.fields).toContainEqual({ id: 'tbl', value: { r1: 'Hit $1M' } });
    const positional = coerceContactCustomFields({ 'contact.milestones': ['A', 'B'] }, catalog);
    expect(positional.fields).toContainEqual({ id: 'tbl', value: { r1: 'A', r2: 'B' } });
  });

  it('file-upload -> array of url strings', () => {
    const { fields } = coerceContactCustomFields({ 'contact.headshot': 'https://x/y.png' }, catalog);
    expect(fields).toContainEqual({ id: 'file', value: ['https://x/y.png'] });
  });

  it('single-select -> label; unknown option is skipped', () => {
    const { fields, skipped } = coerceContactCustomFields(
      { 'contact.stage': 'seed', 'contact.programs': 'Nope' }, catalog);
    expect(fields).toContainEqual({ id: 'sel', value: 'Seed' });
    expect(skipped.some((s) => s.reason === 'no matching options')).toBe(true);
  });

  it('skips fields not in the catalog', () => {
    const { skipped } = coerceContactCustomFields({ 'contact.ghost': 'x' }, catalog);
    expect(skipped[0].reason).toBe('field not in catalog');
  });
});

describe('toTextboxListValue', () => {
  const rows = [{ id: 'r1', label: 'Milestone 1' }, { id: 'r2', label: 'Milestone 2' }];
  it('maps row ids directly', () => {
    expect(toTextboxListValue({ r1: 'x' }, rows)).toEqual({ r1: 'x' });
  });
  it('returns null when nothing resolves', () => {
    expect(toTextboxListValue([], rows)).toBeNull();
    expect(toTextboxListValue('', rows)).toBeNull();
  });
});
