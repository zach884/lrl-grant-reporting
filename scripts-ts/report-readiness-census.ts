// scripts-ts/report-readiness-census.ts — READ-ONLY. Measures whether the fields the funder
// templates need are actually POPULATED on live, which is the difference between a column that
// "traces to a GHL field" and a column a report can really fill.
//
// Written for gate (3)/(4) of the readiness bar; the trace it feeds is
// docs/sprints/funder-field-trace.md. Re-run it to see the gaps close.
//
//   npx vite-node scripts-ts/report-readiness-census.ts
//
// Three censuses:
//   1. activities — record count per activity_type + per-field fill rate WITHIN each type. A funder
//      metric derives from an activity type, so an empty type means an unfillable column.
//   2. companies  — the ~25 firmographic fields every template's left-hand columns come from, plus
//      the hygiene checks that bite at report time: how Michigan is spelled (5 ways) and the
//      literal string "undefined" sitting in the address field.
//   3. contact link — every template wants an owner name + email, which live on the CONTACT, not
//      the company (business.phone/email are null across the board). So the real question is
//      whether each company resolves a contact that HAS them.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
import { enumerateAllContacts } from '../lib/ghl/contacts';

const ACTIVITIES_OBJECT = 'custom_objects.activities';

/**
 * Gateway's authoritative NAICS list — the 31 four-digit codes on `Sheet1` of the funder's own
 * workbook (`Past Grant Reports/Gateway/Apr26_…xlsx`). It is the grant's high-tech definition, so it
 * belongs in config eventually; it lives here for now so the cohort can be measured.
 *
 * WE STORE 6-DIGIT CODES (623 of 663 populated values) AND THE LIST IS 4-DIGIT, so "the same or very
 * similar NAICS code" (Zach) resolves to an unambiguous rule: truncate ours to 4 digits, then compare.
 * Matching on the full 6 digits would return almost nothing.
 */
const GATEWAY_NAICS_4 = [
  '3251', '3252', '3253', '3254', '3259', '3261', '3331', '3332', '3333', '3336', '3339', '3341',
  '3342', '3343', '3344', '3345', '3359', '3361', '3362', '3363', '3364', '3369', '3391', '5112',
  '5174', '5182', '5191', '5413', '5415', '5417', '6215',
];

/** Manufacturing sectors — the i4.0 lens, which is a DIFFERENT set from Gateway's high-tech list. */
const MANUFACTURING_SECTORS = ['31', '32', '33'];

const isMichigan = (state: unknown) => /^(mi|michigan)$/i.test(String(state ?? '').trim());

/** The company fields the TC / SBSH / Gateway / i4.0 templates read. */
const COMPANY_FIELDS = [
  'county', 'naics_code', 'lara_id', 'date_of_incorporation', 'date_registered_in_michigan',
  'date_of_initial_intake', 'fte_current', 'fte_hiring_next_12mo', 'annual_revenue', 'revenue_stage',
  'minority_owned', 'women_owned', 'veteran_owned', 'disabled_owned', 'geo_disadvantaged',
  'high_tech_business', 'business_model', 'mi_registered_entity', 'supported_by_lrl_18mo',
  'trl_current', 'mrl_current', 'crl_current', 'churchill_current',
];

function loadEnvLocal() {
  try {
    const txt = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* ignore */ }
}

const isEmpty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

async function censusActivities(c: ReturnType<typeof ghl>) {
  const all: any[] = [];
  for (let page = 1; page <= 30; page += 1) {
    const d: any = await c.request({
      method: 'POST', path: `/objects/${ACTIVITIES_OBJECT}/records/search`, autoLocation: false,
      body: { locationId: c.locationId, query: '', page, pageLimit: 100, searchAfter: [], sort: [{ field: 'updatedAt', direction: 'desc' }] },
    });
    const recs = d.records ?? d.items ?? [];
    all.push(...recs);
    if (recs.length < 100) break;
  }
  const byType: Record<string, number> = {};
  const fill: Record<string, Record<string, number>> = {};
  for (const r of all) {
    const p = r.properties ?? {};
    const t = String(p.activity_type ?? '(none)');
    byType[t] = (byType[t] ?? 0) + 1;
    fill[t] = fill[t] ?? {};
    for (const [k, v] of Object.entries(p)) if (!isEmpty(v)) fill[t][k] = (fill[t][k] ?? 0) + 1;
  }
  return { total: all.length, byType, fill };
}

async function listAllRaw(c: ReturnType<typeof ghl>) {
  const out: any[] = [];
  let skip = 0;
  for (;;) {
    const d: any = await c.request({ path: '/businesses/', params: { limit: 100, skip } });
    const batch = d.businesses ?? [];
    if (!batch.length) break;
    out.push(...batch);
    if (batch.length < 100) break;
    skip += 100;
  }
  return out;
}

function censusCompanies(biz: any[]) {
  const standard: Record<string, number> = { name: 0, address: 0, city: 0, state: 0, postalCode: 0, phone: 0, website: 0, email: 0 };
  const custom: Record<string, number> = {};
  for (const k of COMPANY_FIELDS) custom[k] = 0;
  const stateSpellings: Record<string, number> = {};
  let addressLiteralUndefined = 0;
  let badZip = 0;
  for (const b of biz) {
    for (const k of Object.keys(standard)) if (!isEmpty(b[k])) standard[k] += 1;
    for (const cf of b.customFields ?? []) {
      const v = cf.valueString ?? cf.valueNumber ?? cf.valueDate ?? cf.value ?? cf.valueArray;
      if (!isEmpty(v) && Object.prototype.hasOwnProperty.call(custom, cf.key)) custom[cf.key] += 1;
    }
    const s = String(b.state ?? '(null)');
    stateSpellings[s] = (stateSpellings[s] ?? 0) + 1;
    if (String(b.address).trim().toLowerCase() === 'undefined') addressLiteralUndefined += 1;
    if (b.postalCode && !/^\d{5}(-\d{4})?$/.test(String(b.postalCode).trim())) badZip += 1;
  }
  return { companies: biz.length, standard, custom, stateSpellings, addressLiteralUndefined, badZip };
}

async function censusContactLink(c: ReturnType<typeof ghl>, biz: any[]) {
  const contacts = await enumerateAllContacts(c);
  const byBiz = new Map<string, any[]>();
  let linked = 0;
  for (const ct of contacts) {
    if (!ct.businessId) continue;
    linked += 1;
    const a = byBiz.get(ct.businessId) ?? [];
    a.push(ct);
    byBiz.set(ct.businessId, a);
  }
  let withContact = 0, withEmail = 0, withName = 0, withPhone = 0;
  for (const b of biz) {
    const cs = byBiz.get(b.id) ?? [];
    if (cs.length) withContact += 1;
    if (cs.some((x: any) => x.email)) withEmail += 1;
    if (cs.some((x: any) => x.firstName && x.lastName)) withName += 1;
    if (cs.some((x: any) => x.phone)) withPhone += 1;
  }
  return { contacts: contacts.length, linkedToACompany: linked, withContact, withEmail, withName, withPhone };
}

/**
 * How many companies each grant's company lens actually selects. This is the "can this report be
 * produced at all" question, and it is separate from field population: a column can be 100% filled
 * and still describe an empty cohort.
 */
function censusEligibility(biz: any[]) {
  const digitLengths: Record<number, number> = {};
  let withNaics = 0, michigan = 0, gatewayNaics = 0, gatewayAndMi = 0, manufacturers = 0, mfgAndMi = 0;
  for (const b of biz) {
    if (isMichigan(b.state)) michigan += 1;
    const cf = (b.customFields ?? []).find((x: any) => x.key === 'naics_code');
    const raw = cf?.valueNumber ?? cf?.valueString;
    if (raw == null || raw === '') continue;
    const digits = String(raw).replace(/\D/g, '');
    if (!digits) continue;
    withNaics += 1;
    digitLengths[digits.length] = (digitLengths[digits.length] ?? 0) + 1;
    const four = digits.slice(0, 4);
    const sector = digits.slice(0, 2);
    if (GATEWAY_NAICS_4.includes(four)) {
      gatewayNaics += 1;
      if (isMichigan(b.state)) gatewayAndMi += 1;
    }
    if (MANUFACTURING_SECTORS.includes(sector)) {
      manufacturers += 1;
      if (isMichigan(b.state)) mfgAndMi += 1;
    }
  }
  return { withNaics, digitLengths, michigan, gatewayNaics, gatewayAndMi, manufacturers, mfgAndMi };
}

async function main() {
  loadEnvLocal();
  process.env.GHL_TARGET = 'live';
  const c = ghl();

  const activities = await censusActivities(c);
  const biz = await listAllRaw(c);
  const companies = censusCompanies(biz);
  const eligibility = censusEligibility(biz);
  const contactLink = await censusContactLink(c, biz);

  const n = companies.companies;
  const pct = (x: number) => `${x}/${n} (${Math.round((x / n) * 100)}%)`;

  console.log(`=== activities: ${activities.total} records`);
  for (const [t, k] of Object.entries(activities.byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(22)} ${k}`);
  }
  console.log(`\n=== companies: ${n}`);
  for (const [k, v] of Object.entries(companies.standard)) console.log(`  ${k.padEnd(28)} ${pct(v)}`);
  for (const [k, v] of Object.entries(companies.custom).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${pct(v)}`);
  console.log(`  ${'address = "undefined"'.padEnd(28)} ${companies.addressLiteralUndefined}`);
  console.log(`  ${'state spellings'.padEnd(28)} ${Object.keys(companies.stateSpellings).length} distinct`);
  console.log(`\n=== eligibility cohorts (the company lens, per grant)`);
  console.log(`  ${'with any NAICS value'.padEnd(28)} ${pct(eligibility.withNaics)}`);
  console.log(`  ${'  digit lengths'.padEnd(28)} ${JSON.stringify(eligibility.digitLengths)}`);
  console.log(`  ${'Michigan address'.padEnd(28)} ${pct(eligibility.michigan)}   <- the TC lens`);
  console.log(`  ${'Gateway NAICS (4-digit)'.padEnd(28)} ${pct(eligibility.gatewayNaics)}`);
  console.log(`  ${'  ...and Michigan'.padEnd(28)} ${pct(eligibility.gatewayAndMi)}   <- the Gateway lens`);
  console.log(`  ${'manufacturers (NAICS 31-33)'.padEnd(28)} ${pct(eligibility.manufacturers)}`);
  console.log(`  ${'  ...and Michigan'.padEnd(28)} ${pct(eligibility.mfgAndMi)}   <- the i4.0 lens (tab 1)`);
  console.log(`\n=== owner name / email (via the linked contact)`);
  console.log(`  ${'>=1 linked contact'.padEnd(28)} ${pct(contactLink.withContact)}`);
  console.log(`  ${'a contact email'.padEnd(28)} ${pct(contactLink.withEmail)}`);
  console.log(`  ${'first + last name'.padEnd(28)} ${pct(contactLink.withName)}`);
  console.log(`  ${'a contact phone'.padEnd(28)} ${pct(contactLink.withPhone)}`);

  mkdirSync(join(process.cwd(), 'reports'), { recursive: true });
  const out = { generatedAt: new Date().toISOString(), activities, companies, eligibility, contactLink };
  writeFileSync(join(process.cwd(), 'reports/report-readiness-census.json'), JSON.stringify(out, null, 2));
  console.log('\nwrote reports/report-readiness-census.json');
}
main().catch((e) => { console.error(e); process.exit(1); });
