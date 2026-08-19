// scripts-ts/appointment-ingest-run.ts — backfill / sweep appointments into activities.
//
// Two jobs, same code path as the webhook (so they cannot drift):
//   • BACKFILL history — there are already 140+ appointments in 2026 that reporting wants.
//   • NIGHTLY SWEEP — the backstop for a webhook that didn't fire, and the thing that picks up a
//     meeting once its start time has passed (a future booking is not an activity yet).
//
// Dry-run by default (house rule: dry-run → review → apply).
//   npx vite-node scripts-ts/appointment-ingest-run.ts --from 2026-01-01 --to 2026-12-31
//   npx vite-node scripts-ts/appointment-ingest-run.ts --from 2026-01-01 --to 2026-12-31 --apply
//   npx vite-node scripts-ts/appointment-ingest-run.ts --days 7 --apply        # the sweep
//
// Only calendars WITH a routing rule are read — an unrouted calendar is skipped without a fetch.

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
const APPLY = process.argv.includes('--apply');

(async () => {
  const { ghl } = await import('../lib/ghl/client');
  const { listRoutes } = await import('../lib/activities/routes');
  const { listAppointments, ingestAppointment, APPOINTMENT_SOURCE } = await import('../lib/activities/sources/appointment');
  const c = ghl();

  const days = arg('--days');
  const to = arg('--to') ? new Date(arg('--to')!) : new Date();
  const from = arg('--from')
    ? new Date(arg('--from')!)
    : new Date(to.getTime() - (Number(days ?? 7) || 7) * 86400000);

  const routes = (await listRoutes({ force: true })).filter((r) => r.source === APPOINTMENT_SOURCE && r.enabled);
  if (!routes.length) {
    console.log('No appointment routing rules configured — nothing to ingest.');
    console.log('Set them up with:  npx vite-node scripts-ts/activity-routes.ts');
    process.exit(0);
  }

  // Expand group rules to the calendars they cover, so we know which calendars to read.
  const cals: any[] = (await c.request<any>({ path: '/calendars/', params: { locationId: c.locationId } })).calendars ?? [];
  const routed = cals.filter((k) =>
    routes.some((r) => (r.matchKind === 'calendar' && r.matchId === k.id) || (r.matchKind === 'calendar_group' && r.matchId === k.groupId)),
  );

  console.log(`target=live  window=${from.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}  calendars=${routed.length}/${cals.length}`);
  console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply to write)\n');

  const tally: Record<string, number> = {};
  const bump = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
  const needsAttention: string[] = [];

  for (const k of routed) {
    const appts = await listAppointments(k.id, from.getTime(), to.getTime(), c);
    console.log(`${String(k.name).slice(0, 44).padEnd(46)} ${String(appts.length).padStart(4)} appointment(s)`);
    for (const a of appts) {
      const r = await ingestAppointment(a, { client: c, dryRun: !APPLY });
      const outcome = r.status === 'ingested' ? (r.activity?.outcome ?? 'would-write') : `skip:${r.reason}`;
      bump(outcome);
      if (r.reason === 'no-company') needsAttention.push(`  ${a.startTime?.slice(0, 10)} ${String(a.title ?? '').slice(0, 40)} — ${r.detail}`);
      // Keep well under the 429 threshold (~0.12s spacing 429s; house rule is >=0.3s).
      await new Promise((res) => setTimeout(res, 320));
    }
  }

  console.log('\nOUTCOMES:', JSON.stringify(tally, null, 1));
  if (needsAttention.length) {
    console.log(`\n⚠️  ${needsAttention.length} appointment(s) skipped because the contact has no company (businessId).`);
    console.log('   These are real meetings that will NOT be counted until the contact is linked to a company:');
    for (const line of needsAttention.slice(0, 25)) console.log(line);
    if (needsAttention.length > 25) console.log(`   …and ${needsAttention.length - 25} more`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
