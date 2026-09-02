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
  const { planRow, judgeCompany, mentionsReferralOrIntro } = await import('../lib/activities/sources/sheetImport');
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

  // A decision key that matches nothing is silent by nature — the row falls through to the cascade
  // and looks like an ordinary unresolved row. That is what happened with "the frame studios":
  // normalizeCompanyName strips "the", so the real key is "frame studios" and the override never
  // fired, so the company was never created. Warn loudly instead of failing quietly.
  const sheetKeys = new Set(doc.rows.map((r) => normName(r.business_name)));
  const orphanKeys = Object.keys(decisions).filter((k) => !sheetKeys.has(k));
  if (orphanKeys.length) {
    console.log(`⚠️  ${orphanKeys.length} override key(s) match NO sheet row — they will do nothing:`);
    for (const k of orphanKeys) console.log(`      ${JSON.stringify(k)}`);
    console.log('    Keys must be the normalizeCompanyName() form (noise words stripped, possessives removed).');
  }

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
  /**
   * dedup key → the source keys of the activities sitting on it.
   *
   * A bare Set of keys made this import unable to CORRECT anything. The rule "skip when an activity
   * of the same type already exists for that company on that date" also matched the records this
   * import itself created, so a re-run skipped 400 of its own rows before reaching the upsert — which
   * is why the relabelled grant-contract notes never landed. Holding the source keys separates the
   * two cases: a collision with SOMEONE ELSE'S record is still a skip (that is the point of the
   * rule — not duplicating an appointment-derived intake, and not duplicating one sheet's row from
   * the other sheet), while a collision with only this row's OWN record falls through to the upsert,
   * which noops or updates. Per-row idempotency was always guaranteed by the source key.
   */
  const existingBy = new Map<string, Set<string>>();
  const noteKey = (k: string, srcId: string) => {
    const set = existingBy.get(k) ?? new Set<string>();
    set.add(srcId);
    existingBy.set(k, set);
  };
  /** Is this key occupied by a record that is NOT the one this row owns? */
  const takenByOther = (k: string, mine: string) =>
    Array.from(existingBy.get(k) ?? []).some((id) => id !== mine);
  /**
   * company id → the source keys of every intake already logged for it, which is the second half of
   * Zach's rule-1 test (*"unless we have already logged an intake meeting with the company"*).
   *
   * The KEYS are stored rather than a bare count so the rule is stable across re-runs. If this held
   * only "has an intake", then a row promoted to intake on one run would, on the next, see its own
   * record as the pre-existing intake and demote itself back to technical assistance — the record
   * flipping type every run. Excluding the row's own key breaks that cycle.
   */
  const intakeKeysByCompany = new Map<string, Set<string>>();
  for (const a of acts) {
    const type = String(a.properties?.activity_type ?? '');
    const date = String(a.properties?.activity_date ?? '').slice(0, 10);
    if (!type || !date) continue;
    const ids = await getRelatedRecordIds(a.id, 'business', c).catch(() => [] as string[]);
    // A referral's counterparty is part of its identity, so record BOTH shapes: the bare key for
    // types where date+type is enough, and the counterparty-qualified key for referrals.
    const cp = String((a.properties as any)?.counterparty_name ?? '').trim().toLowerCase();
    const srcId = String((a.properties as any)?.source_record_id ?? '');
    for (const id of ids) {
      noteKey(`${id}|${date}|${type}`, srcId);
      if (cp) {
        noteKey(`${id}|${date}|${type}|${cp}`, srcId);
      }
      if (type === 'intake') {
        const set = intakeKeysByCompany.get(id) ?? new Set<string>();
        set.add(srcId);
        intakeKeysByCompany.set(id, set);
      }
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  console.log(`indexed ${biz.length} companies, ${contacts.length} contacts, ${acts.length} activities (${existingBy.size} company+date+type keys, ${intakeKeysByCompany.size} companies with an intake)\n`);

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
  /** Records an existing row would CHANGE, so a re-run's review shows corrections, not just creates. */
  // `sheet` is not decoration: row numbers COLLIDE across the two sheets (both have a row 6), so a
  // review file keyed on the number alone points at the wrong row half the time.
  const updates: Array<{ sheet: string; row: number; name: string; type: string; recordId: string; fields: string[] }> = [];

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

    // ── RULE 1 (Zach, 9/2) ──────────────────────────────────────────────────────────────────────
    // "anytime you see notes about referrals or intros to be made, I would say its safe to assume it
    // was an intake meeting, unless we have already logged an intake meeting with the company."
    //
    // This lives here, not in `planRow`, because the exception is about GHL's contents rather than
    // the row's: only the runner knows whether the company already has an intake. The source key is
    // deliberately LEFT ALONE — the `:ta` suffix names the row's one-on-one SLOT, not the type it
    // resolves to, so a promotion updates the existing record instead of orphaning it and creating a
    // second one. (A source-key change is a migration, not a refactor; that lesson cost 7 duplicates.)
    if (mentionsReferralOrIntro(row.notes)) {
      for (const a of plan.activities) {
        if (a.activityType !== 'technical_assistance') continue;
        if (a.values.modality === 'group') continue; // a workshop is not somebody's intake
        const priorIntakes = verdict.companyId ? intakeKeysByCompany.get(verdict.companyId) : undefined;
        const otherIntake = Array.from(priorIntakes ?? []).some((k) => k !== a.sourceRecordId);
        if (otherIntake) { bump('rule1:held-intake-already-logged'); continue; }
        a.activityType = 'intake';
        a.values.activity_name = `Intake – ${String(row.business_name).trim()}`;
        delete (a.values as Record<string, unknown>).modality;
        bump('rule1:promoted-to-intake');
      }
    }

    for (const a of plan.activities) {
      // For a referral the counterparty is part of what makes it a distinct event, so it belongs in
      // the collision key — otherwise three referrals on one day look like one.
      const cp = a.values.counterparty_name ? `|${String(a.values.counterparty_name).toLowerCase()}` : '';
      const dedupKey = `${verdict.companyId ?? `contact:${contactId}`}|${row.date_added}|${a.activityType}${cp}`;
      if (takenByOther(dedupKey, a.sourceRecordId)) { bump(`skip:already-in-ghl:${a.activityType}`); continue; }
      // Plan through the SAME upsert the apply uses, rather than returning here. A dry run that stops
      // short can only say "would-write: 393" whether or not one field differs, which makes the
      // review step decorative — the mistake already fixed in the appointment and form adapters.
      // Now that this import RE-runs to correct records (rule 1, the grant-contract notes), knowing
      // which records would actually change is the whole point of the review.
      const res = await upsertActivity(
        { source: SHEET_SOURCE, sourceRecordId: a.sourceRecordId },
        { type: a.activityType, ...(verdict.companyId ? { companyId: verdict.companyId } : {}), contactIds: contactId ? [contactId] : [], values: a.values },
        { client: c, mode: 'ingest', actorKind: 'sync', actor: { name: 'activity:sheet-import' }, onlyIfAbsent: ['activity_date'], plan: !APPLY },
      );
      bump(`outcome:${res.outcome}`);
      if (res.outcome === 'would-update') {
        updates.push({ sheet: row.source_slug, row: row.row, name: row.business_name, type: a.activityType, recordId: res.recordId, fields: res.written });
      }
      if (!APPLY) { await new Promise((r) => setTimeout(r, 90)); continue; }
      // Deliberately NOT adding the new key to `existingBy`. That index exists to avoid colliding
      // with activities this row does not own; per-row idempotency is already guaranteed by the
      // source key. Adding to it poisoned the run: four distinct referrals for one company on one day
      // (to four different partners) collapsed into one, and 15 rows were silently dropped.
      if (res.outcome === 'created') created.push(res.recordId);
      await new Promise((r) => setTimeout(r, 320));
    }
  }

  console.log('OUTCOMES:', JSON.stringify(tally, null, 1));
  if (updates.length) {
    console.log(`\n${updates.length} EXISTING record(s) would change:`);
    const byField: Record<string, number> = {};
    for (const u of updates) for (const f of u.fields) byField[f] = (byField[f] ?? 0) + 1;
    for (const [f, n] of Object.entries(byField).sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)}  ${f}`);
    writeFileSync(join(process.cwd(), 'reports/sheet-import-updates.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), count: updates.length, updates }, null, 1));
    console.log('   → reports/sheet-import-updates.json');
  }
  const path = join(process.cwd(), 'reports/sheet-import-review.json');
  writeFileSync(path, JSON.stringify({ generatedAt: new Date().toISOString(), count: review.length, review }, null, 1));
  console.log(`\n${review.length} row(s) held for review → reports/sheet-import-review.json`);
  for (const r of review.slice(0, 12)) console.log(`   row ${r.row}: ${String(r.name).slice(0, 34)} — ${r.why}`);
  if (review.length > 12) console.log(`   …and ${review.length - 12} more`);
  if (APPLY) console.log(`\ncreated ${created.length} activity record(s)`);
})().catch((e) => { console.error(e); process.exit(1); });
