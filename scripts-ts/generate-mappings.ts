// scripts-ts/generate-mappings.ts — build the draft contact<->company mapping table
// from the LIVE catalogs and write config/field-mappings.json for human curation.
//
//   npx vite-node scripts-ts/generate-mappings.ts            # preview (no write)
//   npx vite-node scripts-ts/generate-mappings.ts --write    # write config/field-mappings.json
//
// Read-only against GHL. Loads .env.local automatically.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBusinessFieldCatalog, getContactFieldCatalog } from '../lib/ghl/customFields';
import { suggestMappings, resolveMappings, collectIssues, FileMappingStore } from '../lib/mapping';

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
  const write = process.argv.includes('--write');

  const [contactCat, businessCat] = await Promise.all([
    getContactFieldCatalog(),
    getBusinessFieldCatalog(),
  ]);
  console.log(`contact fields: ${contactCat.fields.length}  company fields: ${businessCat.fields.length}`);

  const suggested = suggestMappings(contactCat, businessCat);
  const resolved = resolveMappings(suggested, contactCat, businessCat);
  const issues = collectIssues(resolved);

  console.log(`\nSuggested mappings: ${suggested.length}`);
  for (const r of resolved) {
    const flag = r.issues.some((i) => i.level === 'error') ? ' [ERROR]' : r.issues.length ? ' [warn]' : '';
    console.log(
      `  ${r.contactKey}  ->  ${r.businessKey}  (${r.direction}${r.mirrorDown ? ', mirror' : ''})` +
        `  [${r.contactDataType ?? 'scalar'} / ${r.businessDataType ?? 'scalar'}]${flag}`,
    );
  }
  if (issues.length) {
    console.log(`\nIssues (${issues.length}):`);
    for (const i of issues) console.log(`  ${i.level.toUpperCase()}: ${i.businessKey} <- ${i.contactKey}: ${i.message}`);
  }

  if (write) {
    const set = await new FileMappingStore().save(suggested);
    console.log(`\nWROTE config/field-mappings.json (version ${set.version}, ${set.mappings.length} rows).`);
  } else {
    console.log('\n(preview only — re-run with --write to save config/field-mappings.json)');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
