// scripts-ts/dump-catalogs.ts — read-only dump of live contact + company field catalogs
// to reports/catalog-dump.json for the mapping completeness audit.
//   npx vite-node scripts-ts/dump-catalogs.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getBusinessFieldCatalog, getContactFieldCatalog } from '../lib/ghl/customFields';

function loadEnvLocal() {
  try {
    const txt = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* ignore */ }
}

async function main() {
  loadEnvLocal();
  process.env.GHL_TARGET = 'live';
  const [contact, business] = await Promise.all([
    getContactFieldCatalog(),
    getBusinessFieldCatalog(),
  ]);
  const slim = (c: any) =>
    c.fields.map((f: any) => ({ key: f.fieldKey, name: f.name, dataType: f.dataType }));
  const out = {
    generatedAt: new Date().toISOString(),
    contact: { count: contact.fields.length, fields: slim(contact) },
    business: { count: business.fields.length, fields: slim(business) },
  };
  mkdirSync(join(process.cwd(), 'reports'), { recursive: true });
  writeFileSync(join(process.cwd(), 'reports/catalog-dump.json'), JSON.stringify(out, null, 2));
  console.log(`contact custom fields: ${contact.fields.length}`);
  console.log(`company custom fields: ${business.fields.length}`);
  console.log('wrote reports/catalog-dump.json');
}
main().catch((e) => { console.error(e); process.exit(1); });
