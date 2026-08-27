// scripts-ts/dump-catalogs-full.ts — READ-ONLY dump of every live field catalog that a funder
// template column could trace to (gate (3), the funder-template field trace).
// Adds the Activities + Resources custom objects and each field's OPTIONS to the older
// contact+company dump, because a template column often traces to an option value, not a field.
//   npx vite-node scripts-ts/dump-catalogs-full.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  getBusinessFieldCatalog, getContactFieldCatalog, getObjectKeyFieldCatalog,
} from '../lib/ghl/customFields';

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
  const [contact, business, activities, resources] = await Promise.all([
    getContactFieldCatalog(),
    getBusinessFieldCatalog(),
    getObjectKeyFieldCatalog('custom_objects.activities'),
    getObjectKeyFieldCatalog('custom_objects.resources'),
  ]);
  const slim = (c: any) => ({
    count: c.fields.length,
    folders: (c.folders ?? []).map((f: any) => ({ id: f.id, name: f.name })),
    fields: c.fields.map((f: any) => ({
      key: f.fieldKey,
      name: f.name,
      dataType: f.dataType,
      folder: (c.folders ?? []).find((x: any) => x.id === f.parentId)?.name ?? null,
      options: (f.options ?? []).map((o: any) => (typeof o === 'string' ? o : o.label ?? o.key)),
    })),
  });
  const out = {
    generatedAt: new Date().toISOString(),
    contact: slim(contact),
    business: slim(business),
    activities: slim(activities),
    resources: slim(resources),
  };
  mkdirSync(join(process.cwd(), 'reports'), { recursive: true });
  writeFileSync(join(process.cwd(), 'reports/catalog-dump-full.json'), JSON.stringify(out, null, 2));
  for (const [k, v] of Object.entries(out)) {
    if (k !== 'generatedAt') console.log(`${k}: ${(v as any).count} fields`);
  }
  console.log('wrote reports/catalog-dump-full.json');
}
main().catch((e) => { console.error(e); process.exit(1); });
