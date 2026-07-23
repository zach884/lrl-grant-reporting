// scripts-ts/resources-sync-run.ts — Phase F: sync GHL Resources → Wix `Import1` via the persisted set.
//
//   npx vite-node scripts-ts/resources-sync-run.ts                          # DRY-RUN all (plan only)
//   npx vite-node scripts-ts/resources-sync-run.ts --set-status Published   # DRY-RUN + would-set status
//   npx vite-node scripts-ts/resources-sync-run.ts --set-status Published --apply --yes   # LIVE
//   npx vite-node scripts-ts/resources-sync-run.ts --only <id> --apply --yes # one record
//
// Uses the persisted Resource → Wix set (its resource_status gate decides upsert/update/hide/skip).
// `--set-status X` stamps resource_status = X on each record first (needed once, so the gate lets the
// already-live rows sync as `update`). Match is id ↔ ghlResourceId (all linked), so it NEVER creates
// — it updates the linked row. Idempotent. --apply requires --yes. Reads .env.local.

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
function arg(name: string): string | undefined { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; }
function flag(name: string): boolean { return process.argv.includes(`--${name}`); }

const RES_OBJ = 'custom_objects.resources';
const RES_OBJID = '6a590064ad413a5431fc728e';
const WIX_RES = 'Import1';

async function runPool<T>(items: T[], limit: number, worker: (item: T, i: number) => Promise<void>) {
  let idx = 0; const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: n }, async () => { while (idx < items.length) { const i = idx++; await worker(items[i], i); } }));
}

(async () => {
  loadEnvLocal();
  const apply = flag('apply');
  if (apply && !flag('yes')) { console.error('Refusing to APPLY without --yes (writes to Wix + GHL).'); process.exit(1); }

  const { ghl } = await import('../lib/ghl/client');
  const { getCatalog } = await import('../lib/ghl/catalogCache');
  const { getWixCollectionSchema } = await import('../lib/wix/catalogCache');
  const { getWixStore } = await import('../lib/mapping/wixStore');
  const { syncRecordToWix } = await import('../lib/wix-sync/sync');
  const { writeRecordFields } = await import('../lib/ghl/writeRecord');

  const set = (await getWixStore().setsForSource(RES_OBJ)).find((s) => s.wixCollectionId === WIX_RES);
  if (!set) { console.error('No Resource → Wix set found. Run scripts-ts/set-resource-gate.ts --apply first.'); process.exit(1); }
  if (!set.gate) { console.error('⚠️  The set has NO gate — refusing to run (flood guard). Set the gate first.'); process.exit(1); }

  const catalog = await getCatalog(RES_OBJ, { force: true });
  const schema = await getWixCollectionSchema(WIX_RES, true);
  const c = ghl();
  const setStatus = arg('set-status');
  const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const concurrency = Number(arg('concurrency') ?? 2);

  // Load records.
  const recs: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const d: any = await c.request({ method: 'POST', path: `/objects/${RES_OBJID}/records/search`, autoLocation: false, body: { locationId: process.env.GHL_LOCATION_ID, query: '', page, pageLimit: 100, searchAfter: [], sort: [{ field: 'updatedAt', direction: 'desc' }] } });
    const r = d.records ?? d.data ?? []; recs.push(...r); if (r.length < 100) break;
  }
  let todo = only ? recs.filter((r) => only.includes(r.id ?? r._id)) : recs;
  if (limit) todo = todo.slice(0, limit);

  console.log(`Resources sync ${apply ? 'APPLY' : 'DRY-RUN'} | set "${set.name}" gate=${set.gate.field} | records ${todo.length}${setStatus ? ` | set-status=${setStatus}` : ''}`);

  const actions: Record<string, number> = {}; let statusSet = 0, errs = 0; const samples: string[] = [];
  await runPool(todo, concurrency, async (r) => {
    const id = r.id ?? r._id; const name = (r.properties ?? {}).resources ?? '';
    try {
      // Stamp resource_status first (once) so the gate lets already-live rows sync as `update`.
      if (setStatus) {
        const cur = String((r.properties ?? {}).resource_status ?? '');
        if (cur !== setStatus) {
          if (apply) await writeRecordFields(RES_OBJ, id, { [`${RES_OBJ}.resource_status`]: setStatus }, catalog, c);
          statusSet++;
        }
      }
      const res = await syncRecordToWix(RES_OBJ, id, set, catalog, schema, { apply, ghlClient: c });
      actions[res.action] = (actions[res.action] ?? 0) + 1;
      if (samples.length < 12) samples.push(`  • ${name}: ${res.action}${res.note ? ` (${res.note})` : ''}${res.written.length ? ` [${res.written.map((w: any) => w.targetColumn).join(', ')}]` : ''}`);
    } catch (e: any) { errs++; actions.error = (actions.error ?? 0) + 1; if (samples.length < 12) samples.push(`  • ${name}: ERROR ${e?.message ?? e}`); }
  });

  console.log(`\nActions: ${JSON.stringify(actions)} | status stamped: ${statusSet} | errors: ${errs}`);
  for (const s of samples) console.log(s);
  console.log(apply ? '\n✅ Applied.' : '\nDRY-RUN — re-run with --set-status Published --apply --yes to write.');
  process.exit(errs ? 1 : 0);
})().catch((e) => { console.error('RESOURCES SYNC RUN FAILED:', e?.stack ?? e); process.exit(2); });
