// scripts-ts/add-bank-loan-field.ts — add the ONE field the activities object is missing:
// Bank Loans received in the last 6 months.
//
// WHY. `contact.bank_loans_received_in_the_last_6_months` exists — the Client Reporting form asks
// the question — but the activities object has no counterpart. `mapContactValuesToActivity` matches
// on bare key, so there is no key to match and the figure is silently dropped on EVERY real
// submission, not just on the Gateway import. Found 2026-09-02 while mapping Gateway column V.
//
// It is NOT folded into `other_funding_received_in_the_last_6_months`: "Other" is a reported category
// with its own explanation field, and a funder totals the columns — merging bank debt into it makes
// two figures wrong in a way that still reconciles to the right grand total.
//
//   npx vite-node scripts-ts/add-bank-loan-field.ts            # dry run
//   npx vite-node scripts-ts/add-bank-loan-field.ts --apply
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
import { getObjectKeyFieldCatalog, createObjectField } from '../lib/ghl/customFields';

const APPLY = process.argv.includes('--apply');
const OBJ = 'custom_objects.activities';
const BARE_KEY = 'bank_loans_received_in_the_last_6_months';
const NAME = 'Bank Loans received in the last 6 months';

/** The eight funding figures this one belongs beside. Their folder and dataType are the spec. */
const SIBLINGS = [
  'medc_funding_received_in_the_last_6_months',
  'federal_funding_including_sbir_and_sttr_received_in_the_last_6_months',
  'venture_capital_funding_received_in_the_last_6_months',
  'angle_investor_funding_received_in_the_last_6_months',
  'owner_investment_in_the_last_6_months',
  'new_sales_in_the_last_6_months',
  'other_funding_received_in_the_last_6_months',
];

function env() {
  const t = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
  for (const l of t.split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function main() {
  env(); process.env.GHL_TARGET = 'live';
  const c = ghl();
  console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply to create)\n');

  const cat = await getObjectKeyFieldCatalog(OBJ, c);
  const existing = cat.byKey[`${OBJ}.${BARE_KEY}`];
  if (existing) {
    console.log(`already exists: ${BARE_KEY}  [${(existing as any).dataType}]  id=${(existing as any).id}`);
    return;
  }

  // Take the folder and dataType from the siblings rather than choosing them. A MONETORY field sat
  // among eight NUMERICAL ones would aggregate differently in the report engine, and a field in the
  // wrong folder is invisible to whoever fills the form in.
  const sibs = SIBLINGS.map((k) => cat.byKey[`${OBJ}.${k}`]).filter(Boolean) as any[];
  console.log(`sibling funding fields found: ${sibs.length} of ${SIBLINGS.length}`);
  const types = Array.from(new Set(sibs.map((f) => f.dataType)));
  const folders = Array.from(new Set(sibs.map((f) => f.parentId ?? f.folderId ?? '(none)')));
  console.log(`   dataTypes: ${JSON.stringify(types)}`);
  console.log(`   folders:   ${JSON.stringify(folders)}`);

  if (types.length !== 1) { console.error('\nsiblings disagree on dataType — resolve by hand, do not guess'); process.exit(1); }
  if (folders.length !== 1 || folders[0] === '(none)') { console.error('\nsiblings disagree on folder — resolve by hand, do not guess'); process.exit(1); }

  const dataType = types[0] as string;
  const parentId = folders[0] as string;
  console.log(`\nwould create on ${OBJ}:`);
  console.log(`   fieldKey  ${OBJ}.${BARE_KEY}`);
  console.log(`   name      ${NAME}`);
  console.log(`   dataType  ${dataType}   (matching its 7 siblings)`);
  console.log(`   parentId  ${parentId}`);

  if (!APPLY) { console.log('\nnothing written.'); return; }
  const id = await createObjectField({ objectKey: OBJ, parentId, bareKey: BARE_KEY, name: NAME, dataType }, c);
  console.log(`\ncreated field id=${id}`);

  const after = await getObjectKeyFieldCatalog(OBJ, c);
  const made = after.byKey[`${OBJ}.${BARE_KEY}`] as any;
  console.log(made ? `verified: ${made.fieldKey ?? BARE_KEY}  [${made.dataType}]` : 'VERIFY FAILED — the field is not in the catalog after creation');
}
main().catch((e) => { console.error(e); process.exit(1); });
