// scripts-ts/resources-link-companies.ts — link resource records to the COMPANY they are.
//
// A resource is a directory profile of an organization, so the organization it describes should be
// the company record — that is what makes "who did we refer clients to?" joinable, and what lets the
// referral picker record a company rather than a directory row. Measured 2026-08-19: only **3 of 91**
// resources had a company link.
//
// This links ONLY the unambiguous ones: exactly one company whose normalized name matches. It never
// creates a company. 64 of the 91 resources describe organizations that simply are not in the CRM
// (external agencies, engineering firms), and creating them would silently inflate every
// "COUNT DISTINCT companies served" metric, send the nightly stage scorer over marketing agencies,
// and run geo/LARA enrichment on non-clients — because the company object has **no type/role field**
// to separate clients from providers. Add that field first; then bulk creation becomes safe.
//
//   npx vite-node scripts-ts/resources-link-companies.ts            # dry run
//   npx vite-node scripts-ts/resources-link-companies.ts --apply

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';
const APPLY = process.argv.includes('--apply');

const RESOURCES = 'custom_objects.resources';

(async () => {
  const { ghl } = await import('../lib/ghl/client');
  const { listAllBusinesses } = await import('../lib/ghl/businesses');
  const { getAllRelations, createRelation, resolveAssociationId } = await import('../lib/ghl/associations');
  const { normalizeName } = await import('../lib/dedup/normalize');
  const c = ghl();

  const assocId = await resolveAssociationId('resource_company', c);
  if (!assocId) throw new Error('no `resource_company` association on this location');

  const data: any = await c.request({
    method: 'POST', path: `/objects/${RESOURCES}/records/search`, autoLocation: false,
    body: { locationId: c.locationId, query: '', page: 1, pageLimit: 100, searchAfter: [] },
  });
  const resources: any[] = data.records ?? [];

  const companies = await listAllBusinesses(c);
  const byName = new Map<string, any[]>();
  for (const b of companies) {
    if (!b.name) continue;
    const k = normalizeName(b.name);
    byName.set(k, [...(byName.get(k) ?? []), b]);
  }

  console.log(`resources=${resources.length} companies=${companies.length}`);
  console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply to write)\n');

  let linked = 0, already = 0, ambiguous = 0, noCompany = 0;
  const willLink: Array<{ res: any; company: any }> = [];

  for (const r of resources) {
    const name = String((r.properties ?? {}).resources ?? '').trim();
    if (!name) continue;
    const rels = await getAllRelations(r.id, c);
    if (rels.some((x: any) => x.firstObjectKey === 'business' || x.secondObjectKey === 'business')) {
      already++;
      continue;
    }
    const hits = byName.get(normalizeName(name)) ?? [];
    if (hits.length === 1) willLink.push({ res: r, company: hits[0] });
    else if (hits.length > 1) { ambiguous++; console.log(`  AMBIGUOUS  ${name} → ${hits.length} companies (left for review)`); }
    else noCompany++;
    await new Promise((s) => setTimeout(s, 120));
  }

  console.log(`\nalready linked: ${already} · will link: ${willLink.length} · ambiguous: ${ambiguous} · no company in CRM: ${noCompany}\n`);
  for (const { res, company } of willLink) {
    const name = String((res.properties ?? {}).resources ?? '');
    console.log(`  ${APPLY ? 'link  ' : 'would '} ${name.slice(0, 44).padEnd(46)} → ${company.name}`);
    if (!APPLY) continue;
    try {
      // Company is FIRST in the resource_company definition (business ↔ resource).
      await createRelation({ associationId: assocId, firstRecordId: company.id, secondRecordId: res.id }, c);
      linked++;
    } catch (e: any) {
      console.log(`    ✗ ${String(e?.message).slice(0, 120)}`);
    }
    await new Promise((s) => setTimeout(s, 320));
  }

  if (APPLY) console.log(`\n✅ linked ${linked}. Still unlinked: ${noCompany + ambiguous} (no company record exists — see the header).`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
