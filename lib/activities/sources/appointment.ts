// lib/activities/sources/appointment.ts — GHL appointments → Intake / Technical Assistance activities.
//
// The first ingestion adapter, and the template for the rest: fetch the source event, route it
// through config, resolve the company, then hand everything to `upsertActivity`, which owns
// idempotency. This file decides WHAT an appointment means; it never decides how to write.
//
// Live shape, confirmed 2026-08-19 (140 appointments across 2026):
//   { id, calendarId, groupId, contactId, startTime, endTime, appointmentStatus,
//     assignedUserId, title, notes, address }
//
// Three things measured on the live data drive the design:
//
//   • CANCELLATIONS ARE A THIRD of intake bookings (37 of 112). Ingesting them would inflate the
//     intake count by ~33%, so they are excluded by default.
//   • "showed" IS ALMOST NEVER SET (2 of 140) — the team books through GHL but doesn't mark
//     attendance. So attendance cannot gate ingestion or we would record almost nothing. A
//     confirmed appointment whose start time has passed is treated as held, and the status is
//     written to the record so a report can always re-filter.
//   • EVERY APPOINTMENT HAS ITS OWN ZOOM MEETING ID in `address` (110 distinct ids across 110
//     meetings — not a shared personal room). That is the join key for the Zoom AI Companion work:
//     `past_meetings/{id}` exists only if the meeting actually happened, which is a far better
//     attendance signal than the status field. Parsed and stored now so it is ready then.

import { GhlClient, ghl } from '../../ghl/client';
import { getContact } from '../../ghl/contacts';
import { upsertActivity, type UpsertActivityResult } from '../upsert';
import { resolveRoute, type ActivityRoute } from '../routes';
import type { CreateActivityOptions } from '../create';

export const APPOINTMENT_SOURCE = 'Appointment';

export interface GhlAppointment {
  id: string;
  calendarId?: string;
  groupId?: string;
  contactId?: string;
  startTime?: string;
  endTime?: string;
  appointmentStatus?: string;
  assignedUserId?: string;
  title?: string;
  notes?: string;
  address?: string;
}

/** Statuses that mean the meeting did not happen. Everything else is ingested. */
export const NON_EVENT_STATUSES = new Set(['cancelled', 'invalid', 'noshow']);

export type SkipReason =
  | 'no-route'
  | 'cancelled'
  | 'not-yet-held'
  | 'no-contact'
  | 'no-company'
  | 'no-start-time';

export interface AppointmentIngestResult {
  appointmentId: string;
  status: 'ingested' | 'skipped';
  reason?: SkipReason;
  detail?: string;
  route?: { activityType: string; matchLabel?: string };
  activity?: UpsertActivityResult;
}

/** Fetch one appointment. `autoLocation: false` — this endpoint 422s on a locationId query param. */
export async function getAppointment(id: string, client: GhlClient = ghl()): Promise<GhlAppointment | null> {
  const data = await client.request<any>({ path: `/calendars/events/appointments/${id}`, autoLocation: false });
  const a = data.appointment ?? data.event ?? data;
  return a?.id ? (a as GhlAppointment) : null;
}

/** The Zoom meeting id embedded in the appointment location, if it is a Zoom link. */
export function zoomMeetingId(address: unknown): string | null {
  const m = String(address ?? '').match(/zoom\.us\/(?:j|s|w)\/(\d{8,})/);
  return m ? m[1] : null;
}

/** A collective/class calendar means several clients at once; anything else is 1:1. */
function modalityFor(route: ActivityRoute): string | undefined {
  const fixed = route.defaults?.modality;
  return typeof fixed === 'string' ? fixed : undefined;
}

export interface IngestOptions extends CreateActivityOptions {
  /** Don't write; report what would happen. */
  dryRun?: boolean;
  /** Treat this as "now" when deciding whether a meeting has already happened. */
  now?: Date;
}

/**
 * Turn one appointment into an activity (or explain why not).
 *
 * Skips are first-class results, not errors: "this calendar has no rule" is the NORMAL outcome for
 * a personal calendar, and must stay quiet and cheap.
 */
export async function ingestAppointment(
  appointment: GhlAppointment,
  opts: IngestOptions = {},
): Promise<AppointmentIngestResult> {
  const client = opts.client ?? ghl();
  const base = { appointmentId: appointment.id };

  const route = await resolveRoute(APPOINTMENT_SOURCE, [
    { kind: 'calendar', id: appointment.calendarId },
    { kind: 'calendar_group', id: appointment.groupId },
  ]);
  if (!route) {
    return { ...base, status: 'skipped', reason: 'no-route', detail: `calendar ${appointment.calendarId ?? '(none)'} has no routing rule` };
  }
  const routeInfo = { activityType: route.activityType, matchLabel: route.matchLabel };

  const status = String(appointment.appointmentStatus ?? '').toLowerCase();
  if (NON_EVENT_STATUSES.has(status)) {
    return { ...base, status: 'skipped', reason: 'cancelled', detail: `appointment status is "${status}"`, route: routeInfo };
  }
  if (!appointment.startTime) {
    return { ...base, status: 'skipped', reason: 'no-start-time', route: routeInfo };
  }
  const start = new Date(appointment.startTime);
  const now = opts.now ?? new Date();
  if (start.getTime() > now.getTime()) {
    // A future booking isn't an activity yet. It becomes one when its time passes; the status-change
    // webhook and the nightly sweep both re-deliver it, and idempotency makes that safe.
    return { ...base, status: 'skipped', reason: 'not-yet-held', detail: `starts ${appointment.startTime}`, route: routeInfo };
  }

  if (!appointment.contactId) {
    return { ...base, status: 'skipped', reason: 'no-contact', route: routeInfo };
  }
  const contact = await getContact(appointment.contactId, client).catch(() => null);
  const companyId = (contact as any)?.businessId as string | undefined;
  if (!companyId) {
    // Never invent a company (the resourceRelations rule). An activity on the wrong company is
    // worse than one that is flagged and fixed.
    return {
      ...base,
      status: 'skipped',
      reason: 'no-company',
      detail: `contact ${appointment.contactId} has no businessId — link the contact to its company, then re-run`,
      route: routeInfo,
    };
  }

  const zoomId = zoomMeetingId(appointment.address);
  const values: Record<string, unknown> = {
    activity_date: appointment.startTime,
    activity_name: appointment.title || undefined,
    activity_notes: appointment.notes || undefined,
    appointment_id: appointment.id,
    appointment_status: status || undefined,
    ...(zoomId ? { zoom_meeting_id: zoomId } : {}),
    // Origin, not eligibility — the report engine computes grant attribution from rules.
    ...(route.program?.length ? { program__grant_association: route.program } : {}),
    ...(modalityFor(route) ? { modality: modalityFor(route) } : {}),
    ...(route.defaults ?? {}),
  };
  for (const k of Object.keys(values)) if (values[k] === undefined) delete values[k];

  if (opts.dryRun) {
    return { ...base, status: 'ingested', route: routeInfo, detail: `would write ${Object.keys(values).join(', ')} for company ${companyId}` };
  }

  const activity = await upsertActivity(
    { source: APPOINTMENT_SOURCE, sourceRecordId: appointment.id },
    { type: route.activityType, companyId, contactIds: [appointment.contactId], values },
    { ...opts, mode: 'ingest', actorKind: 'sync' },
  );
  return { ...base, status: 'ingested', route: routeInfo, activity };
}

/** Fetch by id, then ingest. The webhook path. */
export async function ingestAppointmentById(id: string, opts: IngestOptions = {}): Promise<AppointmentIngestResult> {
  const client = opts.client ?? ghl();
  const appointment = await getAppointment(id, client);
  if (!appointment) {
    return { appointmentId: id, status: 'skipped', reason: 'no-route', detail: 'appointment not found' };
  }
  return ingestAppointment(appointment, opts);
}

/** Every appointment on one calendar in a window — the backfill + nightly-sweep reader. */
export async function listAppointments(
  calendarId: string,
  startMs: number,
  endMs: number,
  client: GhlClient = ghl(),
): Promise<GhlAppointment[]> {
  const data = await client.request<any>({
    path: '/calendars/events',
    params: { locationId: client.locationId, calendarId, startTime: String(startMs), endTime: String(endMs) },
  });
  return (data.events ?? data.data ?? []) as GhlAppointment[];
}
