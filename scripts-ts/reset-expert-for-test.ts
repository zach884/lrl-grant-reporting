// scripts-ts/reset-expert-for-test.ts — return an expert contact to "just submitted the form" state.
//
//   npx vite-node scripts-ts/reset-expert-for-test.ts <contactId> [<contactId> …]            # DRY-RUN
//   npx vite-node scripts-ts/reset-expert-for-test.ts <contactId> --apply --yes               # do it
//
// Clears every CONTACT field the app writes itself — the readiness fields the AI enricher produces
// and the Wix row-id write-back — and DELETES the Wix Team row, so the next approval exercises the
// real create path (insert + publish) rather than an update of a row that already exists.
//
// It deliberately does NOT touch anything a human or the form owns: name/email/bio/job title/
// LinkedIn/programs/collectives/headshot/company logo, `status`, or `website_team_tags`.
//
// The list of app-written fields is not hand-maintained here — it is the same set that carries the
// `[AI]`/`[SYNC]` prefix (see scripts-ts/ai-field-rename-plan.ts), i.e. exactly "not submitted on
// the form".
//
// Everything removed is snapshotted to reports/expert-reset-<contactId>.json first, so a reset can
// be undone by hand if a test goes sideways. --apply requires --yes.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';
const flag = (n: string) => process.argv.includes(`--${n}`);

/** Contact fields written by the app, never by the form. */
const APP_WRITTEN = [
  'contact.service_areas',
  'contact.mrl_stops',
  'contact.trl_stops',
  'contact.crl_stops',
  'contact.investor_readiness_stops',
  'contact.readiness_confidence',
  'contact.readiness_rationale',
  'contact.wix_team_row_id',
];

(async () => {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!ids.length) { console.error('Usage: reset-expert-for-test.ts <contactId> [...] [--apply --yes]'); process.exit(1); }
  const apply = flag('apply');
  if (apply && !flag('yes')) { console.error('Refusing to APPLY without --yes (clears GHL fields and DELETES Wix rows).'); process.exit(1); }

  const { getCatalog } = await import('../lib/ghl/catalogCache');
  const { getContact, setContactCustomFields } = await import('../lib/ghl/contacts');
  const { ghl } = await import('../lib/ghl/client');
  const { wix } = await import('../lib/wix/client');
  const { queryItemByMatch, bulkDeleteItems } = await import('../lib/wix/collections');

  const cat: any = await getCatalog('contact', { force: true });
  const g = ghl();
  const w = wix();
  mkdirSync('reports', { recursive: true });

  for (const id of ids) {
    const ct: any = await getContact(id, g);
    if (!ct) { console.log(`\n${id}: contact not found — skipping`); continue; }
    const have = new Map<string, any>();
    for (const cf of ct.customFields ?? []) { const d = cat.byId[cf.id]; if (d) have.set(d.fieldKey, cf.value); }

    console.log(`\n=== ${ct.firstName ?? ''} ${ct.lastName ?? ''} (${id}) ===`);
    console.log(`  keeping  status=${JSON.stringify(have.get('contact.status') ?? null)} · website_team_tags=${JSON.stringify(have.get('contact.website_team_tags') ?? null)}`);

    const toClear = APP_WRITTEN.filter((k) => have.get(k) !== undefined);
    for (const k of APP_WRITTEN) {
      const v = have.get(k);
      console.log(`  ${v === undefined ? '·  already empty' : (apply ? '✂  CLEARING   ' : '✂  would clear')}  ${k}${v === undefined ? '' : ` = ${JSON.stringify(v)?.slice(0, 70)}`}`);
    }

    const row: any = await queryItemByMatch('Team', 'ghlContactId', id, w);
    console.log(`  ${row ? (apply ? '🗑  DELETING Wix row' : '🗑  would delete Wix row') : '·  no Wix row'} ${row?._id ?? ''}${row ? ` (_publishStatus=${row._publishStatus})` : ''}`);

    writeFileSync(join('reports', `expert-reset-${id}.json`), JSON.stringify({
      contactId: id, at: new Date().toISOString(),
      clearedFields: Object.fromEntries(toClear.map((k) => [k, have.get(k)])),
      wixRow: row ?? null,
    }, null, 2));
    console.log(`  snapshot → reports/expert-reset-${id}.json`);

    if (!apply) continue;

    if (toClear.length) {
      // Contact custom fields clear by writing an empty value on the id-keyed payload.
      const fields = toClear.map((k) => ({ id: cat.byKey[k].id, value: '' }));
      await setContactCustomFields(id, fields, g);
    }
    if (row?._id) await bulkDeleteItems('Team', [row._id], w);

    // Read back — a clear that didn't take must not be reported as done.
    const after: any = await getContact(id, g);
    const still = new Map<string, any>();
    for (const cf of after?.customFields ?? []) { const d = cat.byId[cf.id]; if (d) still.set(d.fieldKey, cf.value); }
    const stuck = APP_WRITTEN.filter((k) => {
      const v = still.get(k);
      return v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);
    });
    const rowGone = !(await queryItemByMatch('Team', 'ghlContactId', id, w));
    console.log(`  ${stuck.length ? `❌ still set: ${stuck.join(', ')}` : '✅ all app-written fields cleared'}`);
    console.log(`  ${rowGone ? '✅ Wix row gone' : '❌ Wix row still present'}`);
  }

  console.log(apply ? '\n✅ Reset complete.' : '\nDRY-RUN — re-run with --apply --yes.');
  process.exit(0);
})().catch((e) => { console.error('RESET FAILED:', e?.stack ?? e); process.exit(2); });
