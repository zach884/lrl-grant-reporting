import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const txt = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
for (const line of txt.split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
import { enumerateAllContacts } from '../lib/ghl/contacts';
import { ghl } from '../lib/ghl/client';
(async () => {
  const all = await enumerateAllContacts(ghl());
  const by: Record<string, string[]> = {};
  for (const c of all) { if (!c.businessId) continue; (by[c.businessId] ??= []).push(c.id); }
  writeFileSync(join(process.cwd(), 'reports', 'geo-contacts-roster.json'), JSON.stringify(by));
  console.log(`roster: ${all.length} contacts, ${Object.keys(by).length} companies -> reports/geo-contacts-roster.json`);
  process.exit(0);
})().catch((e) => { console.error('ERR', e?.message ?? e); process.exit(1); });
