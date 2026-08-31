// scripts-ts/sheet-import-run.ts — import historical activities from the workflow-written grant
// spreadsheets. Dry-run by default (house rule).
//
//   python3 scripts/extract-sheet-rows.py > reports/sheet-rows.json     # step 1, reviewable
//   npx vite-node scripts-ts/sheet-import-run.ts                        # step 2, plan only
//   npx vite-node scripts-ts/sheet-import-run.ts --pre-2026             # the safe first slice
//   npx vite-node scripts-ts/sheet-import-run.ts --pre-2026 --apply
//   npx vite-node scripts-ts/sheet-import-run.ts --slug tc-cumulative --limit 20
//
// Why the pre-2026 slice first: GHL holds no intake or TA activity before 2026-01-01, so those rows
// cannot collide with anything and need no dedup reasoning at all. Everything from 2026 onward is
// checked against what already exists (see the dedup rule below).
//
// WHAT THIS NEVER DOES: create a company, or attach an activity to a company it is not confident
// about. A disagreement between the sheet's business name and the contact's current company is a
// REVIEW ITEM — contact.businessId names where a person is now, not who was served then, and no
// similarity score can separate a rename from a job change.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// Type-only, so it is erased at compile time and cannot load the module before .env.local is read.
import type { SheetRow } from '../lib/activities/sources/sheetImport';

for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';

const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const APPLY = process.argv.includes('--apply');
const PRE2026 = process.argv.includes('--pre-2026');
const SLUG = arg('--slug');
const LIMIT = Number(arg('--limit') ?? 0) || 0;

/** Activities imported from a sheet are recorded as Manual — a person did log them, by hand, into a
 *  spreadsheet. The `source_record_id` prefix (`tc-cumulative:row-47`) is what identifies the origin,
 *  so no new picklist option is needed and nothing has to be written to a live option list. */
const SHEET_SOURCE = 'Manual';

(async () => {
  const { ghl } = await import('../lib/ghl/client');
  const { enumerateAllContacts } = await import('../lib/ghl/contacts');
  const { getRelatedRecordIds } = await import('../lib/ghl/associations');
  const { planRow, judgeCompany } = await import('../lib/activities/sources/sheetImport');
  const { upsertActivity } = await import('../lib/activities/upsert');
  const c = ghl();

  const doc = JSON.parse(readFileSync(join(process.cwd(), 'reports/sheet-rows.json'), 'utf8')) as { rows: SheetRow[] };
  let rows = doc.rows;
  if (SLUG) rows = rows.filter((r) => r.source_slug === SLUG);
  if (PRE2026) rows = rows.filter((r) => (r.date_added ?? '') < '2026-01-01');
  if (LIMIT) rows = rows.slice(0, LIMIT);

  console.log(`rows to consider: ${rows.length}${PRE2026 ? '  (pre-2026 slice)' : ''}`);
  console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply to write)\n');

  // ── indexes ─────────────────────────────────────────────────────────────────────────────────────
  const biz: any[] = [];
  for (let skip = 0; ; skip += 100) {
    const d: any = await c.request({ path: '/businesses/', params: { limit: 100, skip } });
    const b = d.businesses ?? [];
    biz.push(...b);
    if (b.length < 100) break;
  }
  const bizName = new Map<string, string>(biz.map((b: any) => [b.id, String(b.name ?? '')]));
  const contacts = await enumerateAllContacts(c);
  const byEmail = new Map<string, any[]>();
  for (const ct of contacts as any[]) {
    if (!ct.email) continue;
    const k = String(ct.email).trim().toLowerCase();
    const a = byEmail.get(k) ?? [];
    a.push(ct);
    byEmail.set(k, a);
  }

  // Existing activities, for the dedup rule: skip when an activity of the SAME resolved type already
  // exists for that company on that date. Measured over the TC sheet: 77 of 271 rows collide, and the
  // collisions concentrate on intake — the one type GHL already captures well, which is corroboration
  // the rule measures something real rather than coincidence.
  const acts: any[] = [];
  for (let page = 1; page <= 30; page += 1) {
    const d: any = await c.request({
      method: 'POST', path: '/objects/custom_objects.activities/records/search', autoLocation: false,
      body: { locationId: c.locationId, query: '', page, pageLimit: 100, searchAfter: [], sort: [{ field: 'updatedAt', direction: 'desc' }] },
    });
    const r = d.records ?? d.items ?? [];
    acts.push(...r);
    if (r.length < 100) break;
  }
  const existing = new Set<string>();
  for (const a of acts) {
    const type = String(a.properties?.activity_type ?? '');
    const date = String(a.properties?.activity_date ?? '').slice(0, 10);
    if (!type || !date) continue;
    const ids = await getRelatedRecordIds(a.id, 'business', c).catch(() => [] as string[]);
    // A referral's counterparty is part of its identity, so record BOTH shapes: the bare key for
    // types where date+type is enough, and the counterparty-qualified key for referrals.
    const cp = String((a.properties as any)?.counterparty_name ?? '').trim().toLowerCase();
    for (const id of ids) {
      existing.add(`${id}|${date}|${type}`);
      if (cp) existing.add(`${id}|${date}|${type}|${cp}`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  console.log(`indexed ${biz.length} companies, ${contacts.length} contacts, ${acts.length} activities (${existing.size} company+date+type keys)\n`);

  // ── plan + apply ────────────────────────────────────────────────────────────────────────────────
  const tally: Record<string, number> = {};
  const bump = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
  const review: any[] = [];
  const created: string[] = [];

  for (const row of rows) {
    const plan = planRow(row);
    if (plan.skip) { bump(`skip:${plan.skip}`); continue; }

    // email → contact → the company it currently belongs to
    let contact: any = null;
    for (const ct of byEmail.get(String(row.email ?? '').trim().toLowerCase()) ?? []) {
      contact = ct;
      if (ct.businessId) break;
    }
    if (!contact) { bump('skip:no-contact'); review.push({ row: row.row, name: row.business_name, why: 'no contact for this email', email: row.email }); continue; }

    const primaryId = contact.businessId ?? null;
    const verdict = judgeCompany(row.business_name, primaryId, primaryId ? bizName.get(primaryId) ?? null : null, `${contact.firstName ?? ''} ${contact.lastName ?? ''}`);
    if (verdict.kind !== 'match') {
      bump(`hold:${verdict.kind}`);
      review.push({
        row: row.row, name: row.business_name, why: verdict.reason,
        contact: `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim(),
        contactPrimary: primaryId ? bizName.get(primaryId) : null,
        activities: plan.activities.map((a) => a.activityType),
      });
      continue;
    }

    for (const a of plan.activities) {
      // For a referral the counterparty is part of what makes it a distinct event, so it belongs in
      // the collision key — otherwise three referrals on one day look like one.
      const cp = a.values.counterparty_name ? `|${String(a.values.counterparty_name).toLowerCase()}` : '';
      const dedupKey = `${verdict.companyId}|${row.date_added}|${a.activityType}${cp}`;
      if (existing.has(dedupKey)) { bump(`skip:already-in-ghl:${a.activityType}`); continue; }
      bump(`${APPLY ? 'write' : 'would-write'}:${a.activityType}${a.dateConfidence === 'approximate' ? ' (approx date)' : ''}`);
      if (!APPLY) continue;
      const res = await upsertActivity(
        { source: SHEET_SOURCE, sourceRecordId: a.sourceRecordId },
        { type: a.activityType, companyId: verdict.companyId, contactIds: [contact.id], values: a.values },
        { client: c, mode: 'ingest', actorKind: 'sync', actor: { name: 'activity:sheet-import' }, onlyIfAbsent: ['activity_date'] },
      );
      bump(`outcome:${res.outcome}`);
      // Deliberately NOT adding the new key to `existing`. That set exists to avoid colliding with
      // activities from OTHER sources; per-row idempotency is already guaranteed by the source key.
      // Adding to it poisoned the run: four distinct referrals for one company on one day (to four
      // different partners) collapsed into one, and 15 rows were silently dropped on the first apply.
      if (res.outcome === 'created') created.push(res.recordId);
      await new Promise((r) => setTimeout(r, 320));
    }
  }

  console.log('OUTCOMES:', JSON.stringify(tally, null, 1));
  const path = join(process.cwd(), 'reports/sheet-import-review.json');
  writeFileSync(path, JSON.stringify({ generatedAt: new Date().toISOString(), count: review.length, review }, null, 1));
  console.log(`\n${review.length} row(s) held for review → reports/sheet-import-review.json`);
  for (const r of review.slice(0, 12)) console.log(`   row ${r.row}: ${String(r.name).slice(0, 34)} — ${r.why}`);
  if (review.length > 12) console.log(`   …and ${review.length - 12} more`);
  if (APPLY) console.log(`\ncreated ${created.length} activity record(s)`);
})().catch((e) => { console.error(e); process.exit(1); });
