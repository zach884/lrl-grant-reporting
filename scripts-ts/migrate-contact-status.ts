// scripts-ts/migrate-contact-status.ts — one-off: migrate a legacy contact.status value.
//
//   npx vite-node scripts-ts/migrate-contact-status.ts                          # DRY-RUN "On Website"→"Published"
//   npx vite-node scripts-ts/migrate-contact-status.ts --apply --yes            # APPLY
//   npx vite-node scripts-ts/migrate-contact-status.ts --from "X" --to "Y" ...  # custom values
//
// Why: the website-profile status picklist was re-keyed to [Pending, Approved, Published, Hidden]
// AFTER the existing team-page contacts had been set, so they still hold the old value
// "On Website". Those 40 are already reviewed + enriched + live, so their correct new status is
// "Published". This sets it so the new contact.status gate treats them correctly (Published→update)
// instead of skipping them as an unrecognized value. Reads .env.local; needs GHL_*.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function loadEnvLocal() {
  try {
    const txt = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* ok */ }
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean { return process.argv.includes(`--${name}`); }

(async () => {
  loadEnvLocal();
  const apply = flag('apply');
  if (apply && !flag('yes')) {
    console.error('Refusing to APPLY without --yes. This writes contact.status on GHL contacts. Re-run with --apply --yes.');
    process.exit(1);
  }
  const from = arg('from') ?? 'On Website';
  const to = arg('to') ?? 'Published';

  const { getContactFieldCatalog } = await import('../lib/ghl/customFields');
  const { enumerateAllContacts } = await import('../lib/ghl/contacts');
  const { readContactField } = await import('../lib/enrichment/contactEngine');
  const { writeRecordFields } = await import('../lib/ghl/writeRecord');

  const catalog = await getContactFieldCatalog();
  const def = catalog.byKey['contact.status'];
  if (!def) { console.error('contact.status not found in catalog'); process.exit(1); }
  const validOptions = (def.options ?? []).map((o) => o.label);
  if (!validOptions.includes(to)) {
    console.error(`Target status "${to}" is not a valid option. Options: ${JSON.stringify(validOptions)}`);
    process.exit(1);
  }

  const all = await enumerateAllContacts();
  const targets = all.filter((c) => String(readContactField(c, catalog, 'contact.status') ?? '') === from);
  console.log(`Migrate contact.status "${from}" → "${to}" | ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Valid status options: ${JSON.stringify(validOptions)}`);
  console.log(`Contacts with status "${from}": ${targets.length}\n`);
  for (const c of targets) console.log(`  ${[c.firstName, c.lastName].filter(Boolean).join(' ')}  (${c.id})`);

  if (!apply) { console.log('\nDRY-RUN — re-run with --apply --yes to write.'); process.exit(0); }

  let ok = 0, err = 0;
  for (const c of targets) {
    try {
      await writeRecordFields('contact', c.id, { 'contact.status': to }, catalog);
      ok++;
    } catch (e: any) {
      err++;
      console.error(`  ✗ ${c.id}: ${e?.message ?? e}`);
    }
  }
  console.log(`\n✅ Updated ${ok} contact(s) to "${to}". ${err} error(s).`);
  process.exit(0);
})().catch((e) => { console.error('MIGRATE FAILED:', e?.stack ?? e); process.exit(2); });
