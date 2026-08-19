// scripts-ts/create-referral-associations.ts — the "referred to" links the referral model needs.
//
// Zach, 2026-08-19: "Our activities should be associated to the contacts and companies that
// participate in them… for a referral we refer a contact at a company to some thing. So there should
// be a contact and company associated as REFERRED, and a contact and/or company and/or resource
// associated as REFERRED TO."
//
// Participants already work (`company_activity` + `activity_contact`), and referred-to CONTACT
// already exists (`referral_received_referred_to`). Missing: referred-to COMPANY and referred-to
// RESOURCE — audited live 2026-08-19.
//
// ⚠️ ASSOCIATION DEFINITIONS ARE PERMANENT. GHL has no delete for them, so a typo in a key or label
// is forever. This script is idempotent and dry-runs by default for exactly that reason.
//
//   npx vite-node scripts-ts/create-referral-associations.ts            # dry run
//   npx vite-node scripts-ts/create-referral-associations.ts --apply

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';
const APPLY = process.argv.includes('--apply');

const ACTIVITIES = 'custom_objects.activities';

const PLAN = [
  {
    key: 'referral_referred_to_company',
    firstObjectKey: 'business',
    firstObjectLabel: 'Referred To',
    secondObjectKey: ACTIVITIES,
    secondObjectLabel: 'Referral Received',
  },
  {
    key: 'referral_referred_to_resource',
    firstObjectKey: 'custom_objects.resources',
    firstObjectLabel: 'Referred To',
    secondObjectKey: ACTIVITIES,
    secondObjectLabel: 'Referral Received',
  },
];

(async () => {
  const { ghl } = await import('../lib/ghl/client');
  const { listAssociationDefs, clearAssociationCache } = await import('../lib/ghl/associations');
  const c = ghl();

  const existing = await listAssociationDefs(c);
  const have = new Set(existing.map((d) => d.key));
  console.log(`target=${process.env.GHL_TARGET}  existing associations: ${existing.length}`);
  console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply to write)\n');

  for (const p of PLAN) {
    if (have.has(p.key)) { console.log(`  exists  ${p.key}`); continue; }
    console.log(`  ${APPLY ? 'create' : 'would '} ${p.key}: ${p.firstObjectKey}(${p.firstObjectLabel}) ↔ ${p.secondObjectKey}(${p.secondObjectLabel})`);
    if (!APPLY) continue;
    const res: any = await c.request({
      method: 'POST', path: '/associations/', autoLocation: false,
      body: { locationId: c.locationId, ...p },
    });
    console.log(`     → id=${res.association?.id ?? res.id ?? '(none returned)'}`);
  }

  if (APPLY) {
    clearAssociationCache();
    const after = await listAssociationDefs(c);
    for (const p of PLAN) {
      const hit = after.find((d) => d.key === p.key);
      console.log(`  ${hit ? '✅' : '❌'} ${p.key}${hit ? ` (${hit.id})` : ' — NOT found after create'}`);
    }
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
