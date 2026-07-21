// scripts-ts/set-team-gate.ts — configure the contact.status gate on the Contact → Team set.
//
//   npx vite-node scripts-ts/set-team-gate.ts            # DRY-RUN (prints the gate it would set)
//   npx vite-node scripts-ts/set-team-gate.ts --apply    # write the gate + visibility to the set
//
// Installs the approval state machine (Zach's model):
//   Pending   → skip   (profile created/updated, awaiting team review — do nothing)
//   Approved  → upsert (create-or-update the Wix row) + publish, then write status back to Published
//   Published → update (steady state: keep the row current, never create, no re-enrich)
//   Hidden    → hide   (unpublish the Wix row; keep it + ids so re-approving restores it)
//   anything else → skip (safe default)
// visibility: publishState  → upsert publishes the row; hide sets it to Draft.
// Idempotent: re-running with the same values is a no-op. Reads .env.local; needs POSTGRES_URL/DATABASE_URL.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WixGate, WixMappingSet, WixMappingSetInput, WixVisibility } from '../lib/mapping/wixTypes';

function loadEnvLocal() {
  try {
    const txt = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* ok */ }
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean { return process.argv.includes(`--${name}`); }

const GATE: WixGate = {
  field: 'contact.status',
  actions: { Approved: 'upsert', Published: 'update', Hidden: 'hide', Pending: 'skip' },
  onPublishSetStatus: 'Published',
};
const VISIBILITY: WixVisibility = { mode: 'publishState' };
// Reverse pointer: after each sync, stamp the Wix row's _id onto the GHL contact so both sides link
// both ways (audit trail + fast dedup guard + hook for a future Wix→GHL direction). Matching still
// uses ghlContactId; this is additive.
const WRITEBACK_FIELD = 'contact.wix_team_row_id';

function toInput(set: WixMappingSet, gate: WixGate, visibility: WixVisibility): WixMappingSetInput {
  return {
    name: set.name,
    sourceObject: set.sourceObject,
    wixSiteId: set.wixSiteId,
    wixCollectionId: set.wixCollectionId,
    matchSourceField: set.matchSourceField,
    matchTargetColumn: set.matchTargetColumn,
    policy: set.policy,
    createPolicy: set.createPolicy,
    gate,
    secondaryMatch: set.secondaryMatch,
    writebackField: WRITEBACK_FIELD,
    visibility,
    enabled: set.enabled,
    rows: set.rows,
  };
}

(async () => {
  loadEnvLocal();
  const apply = flag('apply');
  const { getWixStore } = await import('../lib/mapping/wixStore');
  const store = getWixStore();

  const setId = arg('set');
  const set = setId
    ? await store.getSet(setId)
    : (await store.setsForSource('contact')).find((s) => s.wixCollectionId === 'Team')
      ?? (await store.setsForSource('contact')).find((s) => /team/i.test(s.name))
      ?? null;
  if (!set) { console.error('No Contact → Team mapping set found. Pass --set <id>.'); process.exit(1); }

  console.log(`Target set: "${set.name}" (${set.id})`);
  console.log('Current gate      :', JSON.stringify(set.gate ?? null));
  console.log('Current visibility:', JSON.stringify(set.visibility ?? null));
  console.log('Current writeback :', JSON.stringify(set.writebackField ?? null));
  console.log('\nWill set gate      :', JSON.stringify(GATE));
  console.log('Will set visibility:', JSON.stringify(VISIBILITY));
  console.log('Will set writeback :', JSON.stringify(WRITEBACK_FIELD));

  if (JSON.stringify(set.gate ?? null) === JSON.stringify(GATE)
    && JSON.stringify(set.visibility ?? null) === JSON.stringify(VISIBILITY)
    && (set.writebackField ?? null) === WRITEBACK_FIELD) {
    console.log('\nAlready configured — nothing to do. ✅');
    process.exit(0);
  }
  if (!apply) { console.log('\nDRY-RUN — re-run with --apply to write.'); process.exit(0); }

  const updated = await store.saveSet(set.id, toInput(set, GATE, VISIBILITY));
  console.log(`\n✅ Saved. Gate + visibility now set (version ${updated.version}). Rows preserved: ${updated.rows.length}.`);
  process.exit(0);
})().catch((e) => { console.error('SET GATE FAILED:', e?.stack ?? e); process.exit(2); });
