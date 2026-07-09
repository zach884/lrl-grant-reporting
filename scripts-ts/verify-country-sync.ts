// scripts-ts/verify-country-sync.ts — SANDBOX proof that country syncs as an opaque ISO
// code (no "US"->"United States" corruption, no us/US churn), both directions.
//   npx vite-node scripts-ts/verify-country-sync.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBusinessFieldCatalog, getContactFieldCatalog } from '../lib/ghl/customFields';
import { getBusinessRecord, setBusinessFields } from '../lib/ghl/businesses';
import { getContact, setContactScalars } from '../lib/ghl/contacts';
import { syncContactUp } from '../lib/sync/upsync';
import { syncCompanyDown } from '../lib/sync/downsync';
import { FileMappingStore } from '../lib/mapping';

function loadEnvLocal() {
  const txt = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const CO = '6a4d5ed44ebee47128b4da69', ALICE = '8qKixlRt2Sd2NPaIvfMv', BOB = 'DKlbOHjlxwWsrG4dmYBW';

async function main() {
  loadEnvLocal();
  process.env.GHL_TARGET = 'sandbox';
  const [contactCat, businessCat] = await Promise.all([getContactFieldCatalog(), getBusinessFieldCatalog()]);
  const all = await new FileMappingStore().load();
  const mappings = all.mappings.filter((m) => m.contactKey === 'country' && m.enabled !== false);
  console.log('country mapping under test:', JSON.stringify(mappings[0]));
  const cats = { business: businessCat, contact: contactCat };
  const coCountry = async () => (await getBusinessRecord(CO))?.properties.country;

  console.log('\n1) company.country="us" (lowercase), Alice.country="US" -> up-sync = NO churn');
  await setBusinessFields(CO, { country: 'us' }, businessCat.byKey, undefined, new Set(['country']));
  await setContactScalars(ALICE, { country: 'US' });
  const up1 = await syncContactUp(ALICE, mappings, cats, { apply: true });
  console.log('   up.written:', up1.written, '(expect []) | company.country:', await coCountry(), '(still a code)');

  console.log('\n2) Alice.country="CA" -> up-sync writes CODE "CA" (not "Canada")');
  await setContactScalars(ALICE, { country: 'CA' });
  const up2 = await syncContactUp(ALICE, mappings, cats, { apply: true });
  const c2 = String(await coCountry() ?? '');
  console.log('   up.written:', up2.written, '| company.country:', c2);
  // GHL normalizes a SINGLE_OPTIONS write to the option KEY (lowercase "ca"). What matters:
  // it's the ISO CODE, not the label "Canada".
  const upOk = c2.toLowerCase() === 'ca';
  console.log('   => stored as ISO code (not "Canada"):', upOk);

  console.log('\n3) DOWN: company.country="US", Bob.country="CA" -> down writes CODE "US" to Bob');
  await setBusinessFields(CO, { country: 'US' }, businessCat.byKey, undefined, new Set(['country']));
  await setContactScalars(BOB, { country: 'CA' });
  const down = await syncCompanyDown(CO, mappings, cats, { apply: true });
  const bob = await getContact(BOB);
  const bobRes = down.results.find((r) => r.contactId === BOB);
  console.log('   bob.written:', bobRes?.written, '| bob.country:', bob?.country);
  const downOk = bob?.country === 'US';
  console.log('   => contact got the code, not "United States":', downOk);

  console.log('\n4) idempotency: re-run down -> 0 writes');
  const down2 = await syncCompanyDown(CO, mappings, cats, { apply: true });
  const anyWrites = down2.results.some((r) => r.written.length > 0);
  console.log('   any writes:', anyWrites, '(expect false)');

  // reset both to US for a clean state
  await setContactScalars(ALICE, { country: 'US' });
  await syncContactUp(ALICE, mappings, cats, { apply: true });

  console.log('\nRESULT:', up1.written.length === 0 && upOk && downOk && !anyWrites ? 'PASS ✅' : 'FAIL ❌');
}
main().catch((e) => { console.error(e); process.exit(1); });
