import { describe, it, expect } from 'vitest';
import {
  monthLabel, opportunityName, lastDayOfMonthISO, lastDayEpochMs,
  findMonthlyOpportunity, upsertMonthlyOpportunity, CAFE_FUEL,
} from '../opportunities';

// ---- Minimal fake GhlClient -------------------------------------------------
function fakeClient(existing: any[]) {
  const writes: any[] = [];
  const client: any = {
    locationId: 'LOC',
    async request(opts: any) {
      if (opts.path === '/opportunities/search') return { opportunities: existing };
      writes.push({ method: opts.method, path: opts.path, body: opts.body });
      if (opts.method === 'POST') return { opportunity: { id: 'NEW' } };
      return {};
    },
  };
  return { client, writes };
}
const julyOpp = {
  id: 'JUL',
  name: 'Cafe Fuel | July 2026 Sales',
  monetaryValue: 16523.4,
  customFields: [{ id: CAFE_FUEL.dateFieldId, fieldValueDate: lastDayEpochMs(2026, 7), type: 'date' }],
};

describe('date/name helpers', () => {
  it('formats labels, names, and last-day dates', () => {
    expect(monthLabel(2026, 7)).toBe('July 2026');
    expect(opportunityName(2026, 7)).toBe('Cafe Fuel | July 2026 Sales');
    expect(lastDayOfMonthISO(2026, 2)).toBe('2026-02-28');
    expect(lastDayOfMonthISO(2026, 7)).toBe('2026-07-31');
    expect(lastDayEpochMs(2026, 1)).toBe(Date.UTC(2026, 0, 31));
  });
});

describe('findMonthlyOpportunity', () => {
  it('matches an existing month by reporting-month date', async () => {
    const { client } = fakeClient([julyOpp]);
    const found = await findMonthlyOpportunity(2026, 7, client);
    expect(found?.id).toBe('JUL');
    expect(found?.dateEpochMs).toBe(lastDayEpochMs(2026, 7));
  });
  it('returns null for a month with no opportunity', async () => {
    const { client } = fakeClient([julyOpp]);
    expect(await findMonthlyOpportunity(2026, 8, client)).toBeNull();
  });
});

describe('upsertMonthlyOpportunity', () => {
  it('UPDATEs an existing month (no pipeline/contact in body, ISO date custom field)', async () => {
    const { client, writes } = fakeClient([julyOpp]);
    const r = await upsertMonthlyOpportunity({ year: 2026, month: 7, monetaryValue: 16999.999, dryRun: false, client });
    expect(r.action).toBe('update');
    expect(r.id).toBe('JUL');
    expect(r.monetaryValue).toBe(17000); // rounded to cents
    expect(r.dateISO).toBe('2026-07-31');
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe('PUT');
    expect(writes[0].path).toBe('/opportunities/JUL');
    expect(writes[0].body.pipelineId).toBeUndefined();
    expect(writes[0].body.contactId).toBeUndefined();
    expect(writes[0].body.customFields).toEqual([{ id: CAFE_FUEL.dateFieldId, field_value: '2026-07-31' }]);
  });

  it('CREATEs a missing month (full body incl. pipeline/contact/location)', async () => {
    const { client, writes } = fakeClient([julyOpp]);
    const r = await upsertMonthlyOpportunity({ year: 2026, month: 8, monetaryValue: 12345.6, dryRun: false, client });
    expect(r.action).toBe('create');
    expect(r.id).toBe('NEW');
    expect(writes[0].method).toBe('POST');
    expect(writes[0].path).toBe('/opportunities/');
    expect(writes[0].body.pipelineId).toBe(CAFE_FUEL.pipelineId);
    expect(writes[0].body.pipelineStageId).toBe(CAFE_FUEL.stageId);
    expect(writes[0].body.contactId).toBe(CAFE_FUEL.contactId);
    expect(writes[0].body.locationId).toBe('LOC');
    expect(writes[0].body.customFields).toEqual([{ id: CAFE_FUEL.dateFieldId, field_value: '2026-08-31' }]);
  });

  it('dry-run makes NO writes', async () => {
    const { client, writes } = fakeClient([julyOpp]);
    const r = await upsertMonthlyOpportunity({ year: 2026, month: 8, monetaryValue: 100, dryRun: true, client });
    expect(r.action).toBe('create');
    expect(r.id).toBeUndefined();
    expect(writes).toHaveLength(0);
  });
});
