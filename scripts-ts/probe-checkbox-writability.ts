// scripts-ts/probe-checkbox-writability.ts — is CHECKBOX really unwritable, or did we just never
// send the right shape?
//
//   npx vite-node scripts-ts/probe-checkbox-writability.ts --apply --yes
//
// CONTEXT: `UNWRITABLE_TYPES` in lib/ghl/coerce.ts lists CHECKBOX and TEXTBOX_LIST as "GHL accepts
// and silently drops these in any mode". That conclusion came from the same 2026-07-07 pass that
// wrongly declared MULTIPLE_OPTIONS immutable — and that verdict turned out to be a measurement
// error: we had only ever sent *values*, never an `{add,remove}` MODIFIER. So the same error may be
// hiding here. This probes every shape and reads back after each write.
//
// SAFETY: creates its OWN scratch company, probes only that record, and deletes it at the end
// (including on failure). It never touches a real company. --apply requires --yes.
//
// TEXTBOX_LIST: no field of that type exists on this location, so there is nothing to probe without
// creating one. Left unprobed — nothing currently depends on it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';

const SCRATCH_NAME = 'ZZ API probe — safe to delete (checkbox writability)';

(async () => {
  const apply = process.argv.includes('--apply');
  if (apply && !process.argv.includes('--yes')) {
    console.error('Refusing to APPLY without --yes (creates + deletes a scratch company on live).');
    process.exit(1);
  }

  const { ghl } = await import('../lib/ghl/client');
  const { getCatalog } = await import('../lib/ghl/catalogCache');
  const { createBusiness, deleteBusiness } = await import('../lib/ghl/businesses');

  const c = ghl();
  const catalog = await getCatalog('business', { force: true });
  const field = catalog.fields.find((f: any) => f.dataType === 'CHECKBOX');
  if (!field) { console.error('No CHECKBOX field on the business object — nothing to probe.'); process.exit(1); }

  const bare = field.fieldKey.replace(/^business\./, '');
  const opts = (field.options ?? []).slice(0, 2);
  if (opts.length < 2) { console.error(`CHECKBOX ${field.fieldKey} has <2 options — need 2 to probe add/remove.`); process.exit(1); }

  console.log(`Probing CHECKBOX  ${field.fieldKey}  (id=${field.id})`);
  console.log(`Options used: ${opts.map((o: any) => `${o.key}="${o.label}"`).join(' · ')}`);
  if (!apply) { console.log('\nDRY-RUN — re-run with --apply --yes to create a scratch company and probe.'); process.exit(0); }

  let scratchId: string | undefined;
  const results: Array<{ shape: string; status: string; stored: string }> = [];

  const readBack = async (): Promise<unknown> => {
    const d: any = await c.request({ path: `/objects/business/records/${scratchId}` });
    return (d.record ?? d)?.properties?.[bare];
  };

  const probe = async (shape: string, value: unknown) => {
    let status = '';
    try {
      await c.request({ method: 'PUT', path: `/objects/business/records/${scratchId}`, body: { properties: { [bare]: value } } });
      status = '200';
    } catch (e: any) {
      status = `${e?.status ?? 'ERR'}: ${String(e?.message ?? e).slice(0, 140)}`;
    }
    const stored = await readBack();
    results.push({ shape, status, stored: JSON.stringify(stored ?? null) });
    console.log(`  ${shape.padEnd(42)} → ${status.padEnd(10)} stored=${JSON.stringify(stored ?? null)}`);
  };

  try {
    scratchId = await createBusiness(SCRATCH_NAME, {}, c);
    console.log(`\nScratch company created: ${scratchId}\n`);

    // Every shape, in the same order as the MULTIPLE_OPTIONS evidence matrix.
    await probe('modifier {add:[key]}', { add: [opts[0].key] });
    await probe('modifier {add:[key,key2]}', { add: [opts[0].key, opts[1].key] });
    await probe('modifier {remove:[key]}', { remove: [opts[0].key] });
    await probe('modifier {add:[LABEL]}', { add: [opts[0].label] });
    await probe('plain array [key]', [opts[0].key]);
    await probe('plain array [LABEL]', [opts[0].label]);
    await probe('plain string "key"', opts[0].key);
    await probe('plain string "LABEL"', opts[0].label);
    await probe('plain string delimited "k1;k2"', `${opts[0].key};${opts[1].key}`);
    await probe('boolean true', true);
  } finally {
    if (scratchId) {
      try {
        await deleteBusiness(scratchId, c);
        console.log(`\n🧹 Scratch company ${scratchId} deleted.`);
      } catch (e: any) {
        console.error(`\n⚠️  COULD NOT DELETE scratch company ${scratchId} — delete it by hand: ${e?.message ?? e}`);
      }
    }
  }

  const persisted = results.filter((r) => r.status === '200' && r.stored !== 'null' && r.stored !== '""');
  console.log('\n── VERDICT ──');
  if (persisted.length === 0) {
    console.log('CHECKBOX is genuinely UNWRITABLE via the API — no shape persisted a value.');
    console.log('Keep it in UNWRITABLE_TYPES. This was NOT a measurement error.');
  } else {
    console.log('⚠️  CHECKBOX IS WRITABLE — these shapes persisted:');
    for (const r of persisted) console.log(`   • ${r.shape}  → stored ${r.stored}`);
    console.log('\nUpdate UNWRITABLE_TYPES in lib/ghl/coerce.ts and route it like MULTIPLE_OPTIONS.');
  }
  const destructive = results.filter((r) => r.status === '200' && (r.stored === 'null' || r.stored === '""'));
  if (destructive.length) {
    console.log('\n⚠️  Shapes that returned 200 but stored NOTHING (silent-drop / wipe hazards):');
    for (const r of destructive) console.log(`   • ${r.shape}`);
  }
  process.exit(0);
})().catch((e) => { console.error('CHECKBOX PROBE FAILED:', e?.stack ?? e); process.exit(2); });
