// scripts-ts/verify-address-sync.ts — SANDBOX end-to-end proof that the standard address
// block + website now sync through the REAL engine (up: contact->company, down fan-out).
//   npx vite-node scripts-ts/verify-address-sync.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBusinessFieldCatalog, getContactFieldCatalog } from '../lib/ghl/customFields';
import { getBusinessRecord } from '../lib/ghl/businesses';
import { getContact, setContactScalars } from '../lib/ghl/contacts';
import { syncContactUpAndFanOut } from '../lib/sync/upsync';
import { syncCompanyDown } from '../lib/sync/downsync';
import { FileMappingStore } from '../lib/mapping';

function loadEnvLocal() {
  const txt = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const CO = '6a4d5ed44ebee47128b4da69';       // ZZ Sync Test Co (sandbox)
const ALICE = '8qKixlRt2Sd2NPaIvfMv';        // linked contact
const SCALAR_KEYS = new Set(['address1', 'city', 'state', 'postalCode', 'website']);

async function main() {
  loadEnvLocal();
  process.env.GHL_TARGET = 'sandbox';

  const [contactCat, businessCat] = await Promise.all([getContactFieldCatalog(), getBusinessFieldCatalog()]);
  const all = await new FileMappingStore().load();
  // Only exercise the standard address + website scalar rows.
  const mappings = all.mappings.filter((m) => SCALAR_KEYS.has(m.contactKey) && m.enabled !== false);
  console.log('address/website scalar mappings under test:', mappings.map((m) => `${m.contactKey}->${m.businessKey}`).join(', '));

  const stamp = Date.now();
  const addr = `${stamp} Rocket Rd`;
  const web = `https://sync-${stamp}.example`;

  console.log('\n1) Seed Alice (contact) with a fresh address + website');
  await setContactScalars(ALICE, { address1: addr, city: 'Jackson', state: 'Michigan', postalCode: '49201', website: web });

  console.log('2) UP-sync Alice -> company (+ fan-out) via real engine');
  const up = await syncContactUpAndFanOut(ALICE, mappings, { business: businessCat, contact: contactCat }, { apply: true });
  console.log('   up.written:', up.up.written, '| companyChanged:', up.up.companyChanged);

  const co = await getBusinessRecord(CO);
  console.log('   company now:', JSON.stringify({ address: co?.properties.address, city: co?.properties.city, website: co?.properties.website }));
  const upOk = co?.properties.address === addr && co?.properties.website === web;
  console.log('   => UP address+website landed on company:', upOk);

  console.log('\n3) Idempotency: re-run UP -> expect 0 writes');
  const up2 = await syncContactUpAndFanOut(ALICE, mappings, { business: businessCat, contact: contactCat }, { apply: true });
  console.log('   up2.written:', up2.up.written, '(expect [])');

  console.log('\n4) DOWN fan-out: set Bob\'s website to a DIFFERENT value, push company -> contacts (expect overwrite)');
  const BOB = 'DKlbOHjlxwWsrG4dmYBW';
  await setContactScalars(BOB, { website: `https://stale-${stamp}.example` });
  const down = await syncCompanyDown(CO, mappings, { business: businessCat, contact: contactCat }, { apply: true });
  const bobRes = down.results.find((r) => r.contactId === BOB);
  const bob = await getContact(BOB);
  console.log('   bob.written:', bobRes?.written, '| bob.website now:', bob?.website);
  const downOk = bob?.website === web;
  console.log('   => DOWN overwrote Bob\'s stale website with the company value:', downOk);

  console.log('\n5) Idempotency: re-run DOWN -> expect 0 scalar writes');
  const down2 = await syncCompanyDown(CO, mappings, { business: businessCat, contact: contactCat }, { apply: true });
  const anyWrites = down2.results.some((r) => r.written.length > 0);
  console.log('   any writes on re-run:', anyWrites, '(expect false)');

  console.log('\nRESULT:', upOk && !up2.up.written.length && downOk && !anyWrites ? 'PASS ✅' : 'FAIL ❌');
}
main().catch((e) => { console.error(e); process.exit(1); });
