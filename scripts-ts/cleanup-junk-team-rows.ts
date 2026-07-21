// scripts-ts/cleanup-junk-team-rows.ts — remove non-team rows accidentally inserted into the
// Wix Team CMS (an ungated sync run upserted every contact).
//
//   npx vite-node scripts-ts/cleanup-junk-team-rows.ts             # DRY-RUN (count + sample)
//   npx vite-node scripts-ts/cleanup-junk-team-rows.ts --apply --yes   # DELETE the junk rows
//
// SAFE identification: a legitimate Team-page member always has EIR / Team / Board in `arraystring`.
// Junk rows (non-team contacts) have none of those. So junk = Team rows whose `arraystring` does
// NOT contain any of [EIR, Team, Board]. This cannot match a real member. Destructive → needs
// --apply --yes. Reads .env.local; needs WIX_* creds.

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

const KEEP_TAGS = new Set(['eir', 'team', 'board']);
const isTeamMember = (arraystring: unknown): boolean => {
  const vals = Array.isArray(arraystring) ? arraystring : arraystring == null ? [] : [arraystring];
  return vals.some((v) => KEEP_TAGS.has(String(v).trim().toLowerCase()));
};

(async () => {
  loadEnvLocal();
  const apply = flag('apply');
  if (apply && !flag('yes')) {
    console.error('Refusing to DELETE without --yes. This permanently removes Wix CMS rows. Re-run with --apply --yes.');
    process.exit(1);
  }
  const { wix } = await import('../lib/wix/client');
  const { bulkDeleteItems } = await import('../lib/wix/collections');
  const client = wix();

  // Page through the WHOLE collection INCLUDING draft items — the ungated inserts landed as DRAFT,
  // so a normal (published-only) query misses them. publishPluginOptions.includeDraftItems is the
  // same flag queryItemsByColumn uses.
  const all: any[] = [];
  let cursor: string | undefined;
  for (;;) {
    const body: any = {
      dataCollectionId: 'Team',
      query: { cursorPaging: cursor ? { limit: 100, cursor } : { limit: 100 } },
      publishPluginOptions: { includeDraftItems: true },
    };
    const res: any = await client.request({ method: 'POST', path: '/wix-data/v2/items/query', body });
    const items = (res.dataItems ?? res.items ?? []).map((it: any) => it.data ?? it);
    all.push(...items);
    cursor = res?.pagingMetadata?.cursors?.next;
    if (!cursor || items.length === 0) break;
  }

  const members = all.filter((r) => isTeamMember(r.arraystring));
  const junk = all.filter((r) => !isTeamMember(r.arraystring));
  console.log(`Team CMS total rows: ${all.length}`);
  console.log(`  legitimate members (arraystring has EIR/Team/Board): ${members.length}`);
  console.log(`  JUNK (no membership tag): ${junk.length}`);
  console.log('  sample junk:', junk.slice(0, 8).map((r) => `${r.title_fld || '(no name)'} [${JSON.stringify(r.arraystring ?? null)}]`).join(', '));

  if (!apply) { console.log('\nDRY-RUN — re-run with --apply --yes to DELETE the junk rows.'); process.exit(0); }

  const ids = junk.map((r) => r._id).filter(Boolean);
  const deleted = await bulkDeleteItems('Team', ids, client);
  console.log(`\n✅ Deleted ${deleted} junk row(s). ${members.length} member rows kept.`);
  process.exit(0);
})().catch((e) => { console.error('CLEANUP FAILED:', e?.stack ?? e); process.exit(2); });
