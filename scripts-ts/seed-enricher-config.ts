// scripts-ts/seed-enricher-config.ts — pin the readiness-tagger's gate into enricher_configs.
//
//   npx vite-node scripts-ts/seed-enricher-config.ts            # DRY-RUN (prints what it would write)
//   npx vite-node scripts-ts/seed-enricher-config.ts --apply    # upsert the config row
//
// The engine already falls back to this exact default when no row exists (DEFAULT_ENRICHER_CONFIGS),
// so seeding changes NO behavior — it just makes the gate visible/editable in /enrichment. Idempotent.
// Reads .env.local; needs POSTGRES_URL/DATABASE_URL.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function loadEnvLocal() {
  try {
    const txt = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* ok */ }
}
function flag(name: string): boolean { return process.argv.includes(`--${name}`); }

(async () => {
  loadEnvLocal();
  const apply = flag('apply');
  const { getEnricherConfigStore, DEFAULT_ENRICHER_CONFIGS } = await import('../lib/enrichment/configStore');

  const seed = DEFAULT_ENRICHER_CONFIGS['readiness-tagger::contact'];
  const store = getEnricherConfigStore();

  const current = await store.get(seed.enricher, seed.sourceObject);
  console.log(`Enricher: ${seed.enricher} (${seed.sourceObject})`);
  console.log('Current config:', JSON.stringify(current ?? '(none — code default applies)'));
  console.log('Will seed     :', JSON.stringify({ enabled: seed.enabled, gate: seed.gate, membership: seed.membership }));

  if (current
    && current.enabled === seed.enabled
    && JSON.stringify(current.gate) === JSON.stringify(seed.gate)
    && JSON.stringify(current.membership) === JSON.stringify(seed.membership)) {
    console.log('\nAlready seeded — nothing to do. ✅');
    process.exit(0);
  }
  if (!apply) { console.log('\nDRY-RUN — re-run with --apply to write.'); process.exit(0); }

  const saved = await store.upsert(seed);
  console.log(`\n✅ Seeded enricher config: gate=${JSON.stringify(saved.gate)} membership=${JSON.stringify(saved.membership)}.`);
  process.exit(0);
})().catch((e) => { console.error('SEED ENRICHER CONFIG FAILED:', e?.stack ?? e); process.exit(2); });
