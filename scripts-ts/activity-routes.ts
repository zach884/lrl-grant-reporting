// scripts-ts/activity-routes.ts — inspect and edit the calendar → activity-type routing rules.
//
// Routing is config, not code: Zach expects to create NEW calendars and groups rather than repoint
// the existing (fragile) reporting ones, so adding one must never need a deploy.
//
//   npx vite-node scripts-ts/activity-routes.ts                       # list calendars + current rules
//   npx vite-node scripts-ts/activity-routes.ts --set <calendarId> --type intake [--program gateway]
//   npx vite-node scripts-ts/activity-routes.ts --set-group <groupId> --type technical_assistance
//   npx vite-node scripts-ts/activity-routes.ts --unset <calendarId>
//   ... --default modality=one_on_one --default service_topic=coaching     (repeatable)
//
// WHY `--default` MATTERS. A Technical Assistance activity is only reportable if it carries a
// `modality` (1:1 vs Group): Trusted Connector asks for "# businesses supported 1:1" and
// "# supported through small group TA" as two separate REQUIRED KPIs. Nobody types that field —
// TA is ingested from appointments — so the calendar has to supply it, which is exactly what the
// calendar already knows. `route.defaults` is read by the appointment adapter (see
// lib/activities/sources/appointment.ts, modalityFor + the spread of route.defaults), so this
// writes config, not code. Values are OPTION KEYS, not labels: `one_on_one` / `group`,
// `coaching` / `marketing` / `operations` / `finance` / `product_tech` / `other`. A label is a
// silent no-op.
//
// `service_topic` is meant to come from the Zoom AI Companion summary per meeting (see
// docs/sprints/report-engine-design.md); a route default is the correct interim value, and the
// enricher will overwrite it per meeting once Zoom is wired.
//
// A calendar with NO rule produces NO activity — that is deliberate. Five of the fourteen live
// calendars are personal links used for vendor and partner calls, and inventing activities for
// those would corrupt the reports this feeds.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

(async () => {
  const { ghl } = await import('../lib/ghl/client');
  const { listRoutes, upsertRoute, deleteRoute } = await import('../lib/activities/routes');
  const { APPOINTMENT_SOURCE } = await import('../lib/activities/sources/appointment');
  const c = ghl();

  const setCal = arg('--set');
  const setGroup = arg('--set-group');
  const unset = arg('--unset');
  const type = arg('--type');
  const program = arg('--program');
  // Repeatable: every --default k=v pair, in order.
  const defaults: Record<string, unknown> = {};
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] !== '--default') continue;
    const pair = process.argv[i + 1] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new Error(`--default expects k=v, got ${JSON.stringify(pair)}`);
    defaults[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  const hasDefaults = Object.keys(defaults).length > 0;

  if (unset) {
    await deleteRoute(APPOINTMENT_SOURCE, 'calendar', unset);
    console.log(`removed rule for calendar ${unset} — it will no longer produce activities`);
    process.exit(0);
  }

  if (setCal || setGroup) {
    if (!type) throw new Error('--type is required (e.g. --type intake)');
    const [cals, groups] = await Promise.all([
      c.request<any>({ path: '/calendars/', params: { locationId: c.locationId } }),
      c.request<any>({ path: '/calendars/groups', params: { locationId: c.locationId } }).catch(() => ({ groups: [] })),
    ]);
    const label = setCal
      ? (cals.calendars ?? []).find((x: any) => x.id === setCal)?.name
      : (groups.groups ?? []).find((x: any) => x.id === setGroup)?.name;
    await upsertRoute({
      source: APPOINTMENT_SOURCE,
      matchKind: setCal ? 'calendar' : 'calendar_group',
      matchId: (setCal ?? setGroup)!,
      matchLabel: label,
      activityType: type,
      program: program ? program.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      defaults: hasDefaults ? defaults : undefined,
      enabled: true,
    });
    console.log(`routed ${setCal ? 'calendar' : 'group'} ${JSON.stringify(label ?? (setCal ?? setGroup))} → ${type}${program ? ` (program: ${program})` : ''}${hasDefaults ? ` defaults ${JSON.stringify(defaults)}` : ''}`);
    process.exit(0);
  }

  // Default: show every calendar next to its rule, so the gaps are obvious.
  const [cals, groups, routes] = await Promise.all([
    c.request<any>({ path: '/calendars/', params: { locationId: c.locationId } }),
    c.request<any>({ path: '/calendars/groups', params: { locationId: c.locationId } }).catch(() => ({ groups: [] })),
    listRoutes({ force: true }),
  ]);
  const groupName = new Map((groups.groups ?? []).map((g: any) => [g.id, g.name]));
  const byCal = new Map(routes.filter((r) => r.matchKind === 'calendar').map((r) => [r.matchId, r]));
  const byGroup = new Map(routes.filter((r) => r.matchKind === 'calendar_group').map((r) => [r.matchId, r]));

  console.log('CALENDAR'.padEnd(42), 'GROUP'.padEnd(26), 'ACTIVITY TYPE');
  console.log('-'.repeat(96));
  for (const k of (cals.calendars ?? []).sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)))) {
    const rule = byCal.get(k.id) ?? byGroup.get(k.groupId);
    const via = byCal.has(k.id) ? '' : rule ? ' (via group)' : '';
    console.log(
      String(k.name).slice(0, 40).padEnd(42),
      String(groupName.get(k.groupId) ?? '—').slice(0, 24).padEnd(26),
      rule
        ? `${rule.activityType}${via}${rule.program?.length ? ` [${rule.program.join(',')}]` : ''}${
            rule.defaults && Object.keys(rule.defaults).length
              ? ` {${Object.entries(rule.defaults).map(([k, v]) => `${k}=${v}`).join(' ')}}`
              : ''}`
        : '— not ingested —',
    );
  }
  console.log(`\n${routes.length} rule(s) configured. Calendars with no rule produce no activities (by design).`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
