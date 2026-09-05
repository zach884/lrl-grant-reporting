// diffSubmission is the guard that keeps `noop` reachable. `writeRecordFields` sends every scalar it
// is handed, so if this ever starts returning unchanged fields the client page rewrites the whole
// company record on every save and sync:doctor starts reporting CHURN that is our own fault.

import { describe, expect, it } from 'vitest';
import { diffSubmission, type ClientProfile } from '../profile';

const profile = (fields: ClientProfile['fields']): ClientProfile => ({
  companyId: 'biz_1',
  companyName: 'Acme',
  path: 'tech',
  businessModel: { key: 'business_model', label: 'x', options: [], value: 'Developing a new product' },
  scores: {},
  fields,
});

const f = (over: Partial<ClientProfile['fields'][number]>): ClientProfile['fields'][number] => ({
  key: 'annual_revenue', label: 'Revenue', dataType: 'NUMERICAL', value: '100', multi: false, money: true, ...over,
});

describe('diffSubmission', () => {
  it('keeps only what changed', () => {
    const p = profile([f({}), f({ key: 'paying_customers', value: '3', money: false })]);
    const d = diffSubmission(p, { annual_revenue: '250', paying_customers: '3' });
    expect(d.changed).toEqual({ annual_revenue: '250' });
    expect(d.unchanged).toEqual(['paying_customers']);
  });

  it('treats whitespace-only edits as unchanged', () => {
    const d = diffSubmission(profile([f({})]), { annual_revenue: '  100  ' });
    expect(d.changed).toEqual({});
    expect(d.unchanged).toEqual(['annual_revenue']);
  });

  it('is order-insensitive for multi-selects', () => {
    const p = profile([f({ key: 'patents', dataType: 'MULTIPLE_OPTIONS', multi: true, value: ['B', 'A'], money: false })]);
    expect(diffSubmission(p, { patents: ['A', 'B'] }).changed).toEqual({});
    expect(diffSubmission(p, { patents: ['A'] }).changed).toEqual({ patents: ['A'] });
  });

  it('drops keys the routed profile never offered', () => {
    // The token says which company; the profile says which questions. Neither comes from the body.
    const d = diffSubmission(profile([f({})]), { annual_revenue: '100', trl_current: '9', name: 'Hacked Inc' });
    expect(d.changed).toEqual({});
    expect(Object.keys(d.changed)).not.toContain('trl_current');
    expect(Object.keys(d.changed)).not.toContain('name');
  });

  it('records a newly answered blank', () => {
    const p = profile([f({ key: 'mfg_method', value: '', dataType: 'TEXT', money: false })]);
    expect(diffSubmission(p, { mfg_method: 'In house' }).changed).toEqual({ mfg_method: 'In house' });
  });

  it('records a cleared answer', () => {
    expect(diffSubmission(profile([f({})]), { annual_revenue: '' }).changed).toEqual({ annual_revenue: '' });
  });
});
