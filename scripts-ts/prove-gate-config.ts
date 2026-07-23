// scripts-ts/prove-gate-config.ts — DRY-RUN proof that editing the gate config (what /enrichment
// saves) changes the engine's run/skip decision, with NO GHL/Wix/AI writes.
//
//   npx vite-node scripts-ts/prove-gate-config.ts
//
// It exercises the EXACT functions the real pipeline uses — resolveEnricherConfig (DB read) +
// evaluateContactGate — against a synthetic "Published / Team" contact:
//   1. With the seeded gate (runOn=['Approved']) the contact SKIPS.
//   2. Simulate a UI save that adds 'Published' to runOn (a PUT /api/enrichers/readiness-tagger).
//   3. Re-resolve from the DB → the SAME contact now RUNS.
//   4. Restore the original config so live behavior is unchanged.
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

(async () => {
  loadEnvLocal();
  const { getEnricherConfigStore, resolveEnricherConfig } = await import('../lib/enrichment/configStore');
  const { evaluateContactGate } = await import('../lib/enrichment/gate');
  const store = getEnricherConfigStore();

  // Synthetic contact: Published + Team. `read` is what the pipeline builds from a real contact.
  const read = (k: string) => ({ 'contact.status': 'Published', 'contact.website_team_tags': ['Team'] } as Record<string, unknown>)[k];

  const original = await resolveEnricherConfig('readiness-tagger', 'contact');
  const before = evaluateContactGate(read, original);
  console.log('Seeded gate runOn:', JSON.stringify(original.gate?.runOn));
  console.log(`  → Published/Team contact: ${before.run ? 'RUN' : 'SKIP'}${before.reason ? ` (${before.reason})` : ''}`);

  // Simulate the UI edit: add 'Published' to runOn (identical to a PUT from /enrichment).
  await store.upsert({
    enricher: 'readiness-tagger', sourceObject: 'contact', enabled: original.enabled,
    gate: { field: original.gate?.field ?? 'contact.status', runOn: [...(original.gate?.runOn ?? []), 'Published'] },
    membership: original.membership,
  });

  const edited = await resolveEnricherConfig('readiness-tagger', 'contact');
  const after = evaluateContactGate(read, edited);
  console.log('\nEdited gate runOn:', JSON.stringify(edited.gate?.runOn));
  console.log(`  → Published/Team contact: ${after.run ? 'RUN' : 'SKIP'}${after.reason ? ` (${after.reason})` : ''}`);

  // Restore so live behavior is unchanged by this proof.
  await store.upsert({
    enricher: 'readiness-tagger', sourceObject: 'contact', enabled: original.enabled,
    gate: original.gate, membership: original.membership,
  });
  const restored = await resolveEnricherConfig('readiness-tagger', 'contact');
  console.log('\nRestored gate runOn:', JSON.stringify(restored.gate?.runOn));

  const ok = before.run === false && after.run === true && JSON.stringify(restored.gate?.runOn) === JSON.stringify(original.gate?.runOn);
  console.log(`\n${ok ? '✅ PROVEN' : '❌ FAILED'}: editing the gate in config flipped the engine decision SKIP→RUN, then restored.`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('PROOF FAILED:', e?.stack ?? e); process.exit(2); });
