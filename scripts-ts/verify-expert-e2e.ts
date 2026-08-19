// scripts-ts/verify-expert-e2e.ts — did one approval carry an expert all the way to the map?
//   npx vite-node scripts-ts/verify-expert-e2e.ts <contactId>
// Read-only. Checks each link in the chain separately so a miss says WHICH link failed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';

(async () => {
  const id = process.argv[2];
  const { getCatalog } = await import('../lib/ghl/catalogCache');
  const { getContact } = await import('../lib/ghl/contacts');
  const { ghl } = await import('../lib/ghl/client');
  const { wix } = await import('../lib/wix/client');
  const { queryItemByMatch } = await import('../lib/wix/collections');
  const { queryChangeLog } = await import('../lib/audit/query');

  const cat: any = await getCatalog('contact', { force: true });
  const ct: any = await getContact(id, ghl());
  const f = new Map<string, any>();
  for (const cf of ct?.customFields ?? []) { const d = cat.byId[cf.id]; if (d) f.set(d.fieldKey, cf.value); }
  const row: any = await queryItemByMatch('Team', 'ghlContactId', id, wix(), ['program', 'collectives']);

  const pass: string[] = []; const fail: string[] = [];
  const check = (ok: boolean, label: string, detail = '') => (ok ? pass : fail).push(`${label}${detail ? ` — ${detail}` : ''}`);

  // 1. webhook delivered
  const { rows } = await queryChangeLog({ since: new Date(Date.now() - 30 * 60_000).toISOString(), limit: 200 });
  const mine = (rows as any[]).filter((r) => String(r.recordLabel ?? '').includes(id) || String(r.recordId ?? '') === id);
  check(mine.length > 0, '1. webhook delivered + logged', `${mine.length} change_log event(s)`);

  // 2. enricher ran
  const areas = f.get('contact.service_areas');
  check(Array.isArray(areas) && areas.length > 0, '2. enricher wrote service_areas', JSON.stringify(areas ?? null));
  const stops = ['mrl_stops','trl_stops','crl_stops','investor_readiness_stops']
    .map((k) => [k, f.get(`contact.${k}`)] as const).filter(([, v]) => Array.isArray(v) && v.length);
  check(stops.length > 0, '2b. enricher derived stops', stops.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' '));

  // 3. Wix row created + published
  check(!!row, '3. Wix row created (insert path)', row?._id ?? 'MISSING');
  check(row?._publishStatus === 'PUBLISHED', '3b. row published', String(row?._publishStatus));

  // 4. images imported
  check(!!row?.image_fld, '4. headshot imported', String(row?.image_fld ?? '').slice(0, 48));
  check(!!row?.companyLogo, '4b. company logo imported', String(row?.companyLogo ?? '').slice(0, 48));

  // 5. references resolved — the item 6 fix
  const ghlProgs = (f.get('contact.programs') ?? []) as string[];
  const ghlColls = (f.get('contact.collectives') ?? []) as string[];
  const gotProgs = Array.isArray(row?.program) ? row.program.length : 0;
  const gotColls = Array.isArray(row?.collectives) ? row.collectives.length : 0;
  check(gotProgs === ghlProgs.length, '5. ALL programs resolved', `${gotProgs}/${ghlProgs.length} (${ghlProgs.join(', ')})`);
  check(gotColls === ghlColls.length, '5b. ALL collectives resolved', `${gotColls}/${ghlColls.length} (${ghlColls.join(', ')})`);

  // 6. status write-back
  check(String(f.get('contact.status')) === 'Published', '6. status written back Approved → Published', String(f.get('contact.status')));

  // 7. id write-back + provenance
  check(String(f.get('contact.wix_team_row_id') ?? '') === String(row?._id ?? 'x'), '7. Wix row id written back', String(f.get('contact.wix_team_row_id') ?? 'MISSING'));
  check(!!row?.image_fldSrc, '7b. image provenance stamped (so re-runs are noop)', row?.image_fldSrc ? 'set' : 'MISSING');

  console.log(`\n${ct?.firstName} ${ct?.lastName} — end-to-end check\n`);
  for (const p of pass) console.log(`  ✅ ${p}`);
  for (const x of fail) console.log(`  ❌ ${x}`);
  console.log(`\n${pass.length} passed · ${fail.length} failed`);
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('VERIFY FAILED:', e?.stack ?? e); process.exit(2); });
