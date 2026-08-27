// The appointment adapter: what an appointment MEANS. Writing is upsertActivity's job (tested
// separately); these cases are the judgement calls, and each maps to something measured on the
// live calendars (see docs/sprints/activity-tracking.md).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../routes', () => ({ resolveRoute: vi.fn() }));
vi.mock('../upsert', async (orig) => ({
  ...(await orig<any>()),
  upsertActivity: vi.fn(async () => ({ recordId: 'act1', outcome: 'created', written: ['activity_date'], skipped: [] })),
}));

import { resolveRoute } from '../routes';
import { upsertActivity } from '../upsert';
import { ingestAppointment, zoomMeetingId, APPOINTMENT_SOURCE, type GhlAppointment } from '../sources/appointment';

const mockRoute = resolveRoute as unknown as ReturnType<typeof vi.fn>;
const mockUpsert = upsertActivity as unknown as ReturnType<typeof vi.fn>;

const NOW = new Date('2026-08-19T12:00:00Z');

const appt = (over: Partial<GhlAppointment> = {}): GhlAppointment => ({
  id: 'appt1',
  calendarId: 'cal-intake',
  groupId: 'grp-general',
  contactId: 'c1',
  startTime: '2026-08-18T15:30:00-04:00',
  appointmentStatus: 'confirmed',
  assignedUserId: 'u1',
  title: 'Intake Meeting with Carrie Joers',
  notes: '',
  address: 'https://zoom.us/j/96350965251?pwd=4TdRCQazMbI9DjAvgAnt8CZ5MtqmxK.1',
  ...over,
});

/** Contacts, so company resolution can be exercised. `businessId` is the company link. */
const CONTACTS: Record<string, any> = {
  c1: { id: 'c1', firstName: 'Carrie', lastName: 'Joers', businessId: 'biz1' },
  'c-nolink': { id: 'c-nolink', firstName: 'Unlinked', lastName: 'Person' },
};

const client: any = {
  locationId: 'LOC',
  async request({ path }: any) {
    const m = path.match(/^\/contacts\/(.+)$/);
    if (m) {
      const c = CONTACTS[m[1]];
      if (!c) throw new Error('not found');
      return { contact: c };
    }
    throw new Error(`unexpected ${path}`);
  },
};

const ROUTE = { source: APPOINTMENT_SOURCE, matchKind: 'calendar', matchId: 'cal-intake', matchLabel: 'New Client Intake Meeting', activityType: 'intake', enabled: true };

beforeEach(() => {
  mockRoute.mockReset();
  mockUpsert.mockClear();
  mockRoute.mockResolvedValue(ROUTE);
});

describe('ingestAppointment', () => {
  it('creates an activity of the calendar\'s routed type', async () => {
    const r = await ingestAppointment(appt(), { client, now: NOW });
    expect(r.status).toBe('ingested');
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const [key, input] = mockUpsert.mock.calls[0];
    expect(key).toEqual({ source: 'Appointment', sourceRecordId: 'appt1' });
    expect(input.type).toBe('intake');
    expect(input.companyId).toBe('biz1');
    expect(input.contactIds).toEqual(['c1']);
  });

  it('keys idempotency on the appointment id, so a re-delivery hits the same record', async () => {
    await ingestAppointment(appt(), { client, now: NOW });
    await ingestAppointment(appt({ appointmentStatus: 'showed' }), { client, now: NOW });
    const ids = mockUpsert.mock.calls.map((c: any[]) => c[0].sourceRecordId);
    expect(ids).toEqual(['appt1', 'appt1']);
  });

  it('records the status and the Zoom meeting id', async () => {
    await ingestAppointment(appt(), { client, now: NOW });
    const values = mockUpsert.mock.calls[0][1].values;
    expect(values.appointment_status).toBe('confirmed');
    expect(values.zoom_meeting_id).toBe('96350965251');
    expect(values.appointment_id).toBe('appt1');
    expect(values.activity_date).toBe('2026-08-18T15:30:00-04:00');
  });

  it('stamps the route\'s program as an ORIGIN hint (not eligibility — that is report-time)', async () => {
    mockRoute.mockResolvedValue({ ...ROUTE, program: ['gateway'] });
    await ingestAppointment(appt(), { client, now: NOW });
    expect(mockUpsert.mock.calls[0][1].values.program__grant_association).toEqual(['gateway']);
  });

  it('applies the route\'s fixed defaults (e.g. modality on a group calendar)', async () => {
    mockRoute.mockResolvedValue({ ...ROUTE, activityType: 'technical_assistance', defaults: { modality: 'group', service_topic: 'coaching' } });
    const values = (await ingestAppointment(appt(), { client, now: NOW }), mockUpsert.mock.calls[0][1].values);
    expect(values.modality).toBe('group');
    expect(values.service_topic).toBe('coaching');
  });

  it('ingests NOTHING for an unrouted calendar — the personal-calendar case', async () => {
    mockRoute.mockResolvedValue(null);
    const r = await ingestAppointment(appt({ calendarId: 'cal-personal' }), { client, now: NOW });
    expect(r).toMatchObject({ status: 'skipped', reason: 'no-route' });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'noshow', 'invalid'])('skips a %s appointment', async (status) => {
    const r = await ingestAppointment(appt({ appointmentStatus: status }), { client, now: NOW });
    expect(r).toMatchObject({ status: 'skipped', reason: 'cancelled' });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('skips a booking that has not happened yet', async () => {
    const r = await ingestAppointment(appt({ startTime: '2026-09-01T15:30:00-04:00' }), { client, now: NOW });
    expect(r).toMatchObject({ status: 'skipped', reason: 'not-yet-held' });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('refuses to guess a company when the contact has no businessId', async () => {
    const r = await ingestAppointment(appt({ contactId: 'c-nolink' }), { client, now: NOW });
    expect(r).toMatchObject({ status: 'skipped', reason: 'no-company' });
    expect(r.detail).toMatch(/link the contact to its company/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('falls back to the calendar GROUP rule when the calendar has none', async () => {
    await ingestAppointment(appt(), { client, now: NOW });
    expect(mockRoute.mock.calls[0][1]).toEqual([
      { kind: 'calendar', id: 'cal-intake' },
      { kind: 'calendar_group', id: 'grp-general' },
    ]);
  });

  it('plans through the real code path on a dry run, in plan mode', async () => {
    // A dry run must reach upsertActivity with plan:true rather than stopping short of it. Skipping
    // it entirely (the previous behaviour) meant the review could only restate the desired values,
    // so a backfill printed "would write ..." for every appointment and three real updates were
    // indistinguishable from eighty-four no-ops.
    const r = await ingestAppointment(appt(), { client, now: NOW, dryRun: true });
    expect(r.status).toBe('ingested');
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0][2]).toMatchObject({ plan: true });
  });

  it('does not pass plan mode on an apply', async () => {
    await ingestAppointment(appt(), { client, now: NOW });
    expect(mockUpsert.mock.calls[0][2].plan).toBeFalsy();
  });
});

describe('zoomMeetingId', () => {
  it('extracts the meeting id from a GHL appointment location', () => {
    expect(zoomMeetingId('https://zoom.us/j/96350965251?pwd=abc')).toBe('96350965251');
    expect(zoomMeetingId('https://us02web.zoom.us/j/1234567890')).toBe('1234567890');
  });

  it('is null for anything that is not a Zoom link', () => {
    expect(zoomMeetingId('')).toBeNull();
    expect(zoomMeetingId(undefined)).toBeNull();
    expect(zoomMeetingId('LRL office, 100 W Michigan Ave')).toBeNull();
    expect(zoomMeetingId('https://meet.google.com/abc-defg-hij')).toBeNull();
  });
});
