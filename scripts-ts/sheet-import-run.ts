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

/** Zach's review decisions, so a judgement made once is recorded rather than re-made each run. */
interface Decision { companyName?: string; create?: boolean; contactOnly?: boolean; note?: string }

(async () => {
  const { ghl } = await import('../lib/ghl/client');
  const { enumerateAllContacts } = await import('../lib/ghl/contacts');
  const { getRelatedRecordIds } = await import('../lib/ghl/associations');
  const { planRow, judgeCompany } = await import('../lib/activities/sources/sheetImport');
  const { upsertActivity } = await import('../lib/activities/upsert');
  const c = ghl();

  const { normalizeCompanyName: normName } = await import('../lib/sync/identityGuard');
  let decisions: Record<string, Decision> = {};
  try {
    decisions = JSON.parse(readFileSync(join(process.cwd(), 'reports/sheet-import-overrides.json'), 'utf8')).decisions ?? {};
    console.log(`loaded ${Object.keys(decisions).length} review decision(s) from reports/sheet-import-overrides.json`);
  } catch { console.log('no overrides file — every disagreement will be held for review'); }
  const decisionFor = (name: string): Decision | undefined => decisions[normName(name)];

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
  // Name index over every company, for the fallback when the sheet's email is not the one GHL holds.
  const { normalizeCompanyName, namesLookAlike } = await import('../lib/sync/identityGuard');
  const bizByNorm = new Map<string, string[]>();
  for (const b of biz as any[]) {
    const k = normalizeCompanyName(b.name);
    if (!k) continue;
    const a = bizByNorm.get(k) ?? [];
    a.push(b.id);
    bizByNorm.set(k, a);
  }
  /** Find a company by name: exact normalized first, then the fuzzy comparison. One hit or nothing —
   *  two candidates is ambiguous and must never be guessed at. */
  const findCompanyByName = (name: string): string | null => {
    const k = normalizeCompanyName(name);
    if (!k) return null;
    const exact = bizByNorm.get(k);
    if (exact?.length === 1) return exact[0];
    if (exact && exact.length > 1) return null;
    const hits: string[] = [];
    // Array.from: the tsconfig target predates downlevelIteration, so Maps are not directly iterable.
    for (const [nk, ids] of Array.from(bizByNorm.entries())) if (namesLookAlike(k, nk)) hits.push(...ids);
    return hits.length === 1 ? hits[0] : null;
  };
  // Contacts per company, so a borrowed association is only ever made when it is unambiguous.
  const contactsForCompany = new Map<string, string[]>();
  const contacts = await enumerateAllContacts(c);
  const byEmail = new Map<string, any[]>();
  for (const ct of contacts as any[]) {
    if (ct.businessId) {
      const a = contactsForCompany.get(ct.businessId) ?? [];
      a.push(ct.id);
      contactsForCompany.set(ct.businessId, a);
    }
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

  const toCreate = new Map<string, SheetRow>();
  const created_companies = new Map<string, string>();
  /** Create a company from the sheet row's firmographics — the row carries everything a record needs. */
  async function createCompanyFromRow(row: SheetRow): Promise<string> {
    const { createBusiness } = await import('../lib/ghl/businesses');
    // Michigan arrives five ways across these sheets (Michigan / MI / Mi / mi / MICHIGAN); normalize
    // on the way in rather than leaving the report engine to do it for every new record.
    const st = String(row.state ?? '').trim();
    const state = /^(mi|michigan)$/i.test(st) ? 'MI' : st;
    const extra: Record<string, unknown> = {};
    if (row.address && row.address !== 'undefined') extra.address = row.address;
    if (row.city) extra.city = row.city;
    if (state) extra.state = state;
    if (row.zip) extra.postalCode = row.zip;
    const id = await createBusiness(row.business_name.trim(), extra, c);
    console.log(`   + created company ${JSON.stringify(row.business_name.trim())} → ${id}`);
    return id;
  }

  // ── plan + apply ────────────────────────────────────────────────────────────────────────────────
  const tally: Record<string, number> = {};
  const bump = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
  const review: any[] = [];
  const created: string[] = [];

  for (const row of rows) {
    const plan = planRow(row);
    if (plan.skip) { bump(`skip:${plan.skip}`); continue; }

    // A recorded decision short-circuits the cascade — the judgement was already made by a person.
    const decision = decisionFor(row.business_name);
    let forcedCompanyId: string | null = null;
    let contactOnly = false;
    if (decision) {
      if (decision.contactOnly) contactOnly = true;
      else if (decision.companyName) {
        const want = normName(decision.companyName);
        const hit = (biz as any[]).find((b) => normName(b.name) === want);
        if (!hit) { bump('error:override-company-not-found'); review.push({ row: row.row, name: row.business_name, why: `override names "${decision.companyName}" but no such company exists` }); continue; }
        forcedCompanyId = hit.id;
      } else if (decision.create) {
        const want = normName(row.business_name);
        const hit = (biz as any[]).find((b) => normName(b.name) === want);
        if (hit) forcedCompanyId = hit.id;
        else if (!APPLY) { bump('would-create-company'); toCreate.set(want, row); }
        else {
          const madeId = created_companies.get(want) ?? await createCompanyFromRow(row);
          created_companies.set(want, madeId);
          forcedCompanyId = madeId;
        }
      }
    }

    // ── resolution CASCADE. Every signal gets tried before giving up, which the first three
    // versions of this did not do — they made one signal primary and stopped. The sheet's email is
    // frequently a business address (ramanufacturingllc@gmail.com) where GHL holds the person's work
    // address (robert@ramfg-usa.com), so an email miss says nothing about whether the company exists.
    let contact: any = null;
    for (const ct of byEmail.get(String(row.email ?? '').trim().toLowerCase()) ?? []) {
      contact = ct;
      if (ct.businessId) break;
    }
    let companyId: string | null = forcedCompanyId;
    let how = forcedCompanyId ? 'override' : '';

    // A contact-only decision needs a contact and nothing else.
    if (contactOnly) {
      if (!contact) { bump('skip:contact-only-but-no-contact'); review.push({ row: row.row, name: row.business_name, why: 'marked contact-only but no contact matches the email', email: row.email }); continue; }
      bump('resolved:contact-only');
    }

    const primaryId = contact?.businessId ?? null;
    if (!companyId && !contactOnly && primaryId) {
      const verdict = judgeCompany(row.business_name, primaryId, bizName.get(primaryId) ?? null, `${contact.firstName ?? ''} ${contact.lastName ?? ''}`);
      if (verdict.kind === 'match') { companyId = verdict.companyId; how = 'email'; }
      else {
        // The contact belongs somewhere else. The sheet may still name a company that exists — that is
        // the former-company case — but which of the two is right is a human's call, not a score's.
        bump('hold:review');
        review.push({
          row: row.row, name: row.business_name, why: verdict.reason,
          contact: `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim(),
          contactPrimary: bizName.get(primaryId) ?? null,
          alsoExistsByName: findCompanyByName(row.business_name) ? bizName.get(findCompanyByName(row.business_name)!) : null,
          activities: plan.activities.map((a) => a.activityType),
        });
        continue;
      }
    }
    if (!companyId && !contactOnly) {
      // No usable contact link — fall back to the company NAME, which is how these seven were found:
      // RA Manufacturing LLC, DoughNation Bakery, Mport Media Group, Kim's Konfections, Ivory Lane
      // Boutique, Wise Home Care Services, Kev's Car Care all exist with near-identical names.
      const byName = findCompanyByName(row.business_name);
      if (byName) { companyId = byName; how = contact ? 'name (contact unlinked)' : 'name (no contact matched the email)'; }
    }
    if (!companyId && !contactOnly) {
      bump(contact ? 'hold:create' : 'skip:unresolved');
      review.push({
        row: row.row, name: row.business_name,
        why: contact ? 'contact exists but has no company, and no company matches the name' : 'no contact for this email and no company matches the name',
        email: row.email, owner: row.owner_name,
      });
      continue;
    }
    if (how) bump(`resolved:${how}`);
    // Associate the contact we actually matched. Failing that, borrow the company's contact ONLY when
    // it has exactly one — attaching a specific wrong person is worse than attaching nobody, and the
    // company association is what a funder row is built from anyway.
    const onCompany = companyId ? contactsForCompany.get(companyId) ?? [] : [];
    const contactId = contact?.id ?? (onCompany.length === 1 ? onCompany[0] : null);
    const verdict = { kind: 'match' as const, companyId, reason: how || 'contact-only' };

    for (const a of plan.activities) {
      // For a referral the counterparty is part of what makes it a distinct event, so it belongs in
      // the collision key — otherwise three referrals on one day look like one.
      const cp = a.values.counterparty_name ? `|${String(a.values.counterparty_name).toLowerCase()}` : '';
      const dedupKey = `${verdict.companyId ?? `contact:${contactId}`}|${row.date_added}|${a.activityType}${cp}`;
      if (existing.has(dedupKey)) { bump(`skip:already-in-ghl:${a.activityType}`); continue; }
      bump(`${APPLY ? 'write' : 'would-write'}:${a.activityType}${a.dateConfidence === 'approximate' ? ' (approx date)' : ''}`);
      if (!APPLY) continue;
      const res = await upsertActivity(
        { source: SHEET_SOURCE, sourceRecordId: a.sourceRecordId },
        { type: a.activityType, ...(verdict.companyId ? { companyId: verdict.companyId } : {}), contactIds: contactId ? [contactId] : [], values: a.values },
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
