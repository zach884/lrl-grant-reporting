// scripts-ts/gateway-metrics-run.ts — import the seven Gateway semi-annual workbooks as DATED
// metrics snapshots. Dry-run by default (house rule).
//
//   python3 scripts/extract-gateway-metrics.py > reports/gateway-metrics-rows.json   # step 1
//   npx vite-node scripts-ts/gateway-metrics-run.ts --workbook gateway-apr-2023      # step 2, plan
//   npx vite-node scripts-ts/gateway-metrics-run.ts --workbook gateway-apr-2023 --apply
//   npx vite-node scripts-ts/gateway-metrics-run.ts                                  # all seven
//
// Import OLDEST FIRST (`--workbook`), so a mistake is caught on 33 rows and not on 227.
//
// RESOLUTION. Email first, always. But email-only left 51 of 227 rows on the floor — and some of
// those companies plainly exist in GHL (Blue Entity, Mport Media Group, Ulendo). Same thing the sheet
// import hit: the workbook's address and GHL's address are simply two different emails for one
// business. So there is a second step, GUARDED the way the sheet import's is:
//
//   1. email -> contact -> contact.businessId, with checkCompanyIdentity confirming the company
//   2. else company NAME, but only on a UNIQUE hit (exact normalized, or namesLookAlike)
//   3. else review — never a guess
//
// Measured 2026-09-02 over the 54 unresolved rows: step 2 recovers 27 with **zero ambiguous
// matches**, and the other 27 companies are genuinely absent from GHL, so there is nothing to attach
// them to. A name match is never accepted when it hits more than one company: the TC sheet produced
// a false positive that resolved to an entirely different business, and a snapshot on the wrong
// company is invisible afterwards.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GatewayRow } from '../lib/activities/sources/gatewayMetrics';

// Local dev reads .env.local; in CI (GitHub Actions) the secrets arrive as real env vars and the
// file does not exist — an unguarded readFileSync ENOENTs the whole run before it starts.
try {
  for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env.local (CI) — env is already populated */ }
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';

const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const APPLY = process.argv.includes('--apply');
const WORKBOOK = arg('--workbook');
const LIMIT = Number(arg('--limit') ?? 0) || 0;

/**
 * The snapshot claims the SAME source the Client Reporting form uses.
 *
 * Activity identity is (source, source_record_id) — BOTH halves — the 2026-08-19 lesson that nearly
 * created 54 duplicate grants. Claiming `Form`/`<contactId>:<periodEnd>` makes the consequence the
 * desired one: a real submission covering one of these seven periods UPDATES the imported snapshot
 * rather than creating a second one for the same half-year. A follow-on-funding figure counted twice
 * is exactly the error that survives review, because both rows look plausible.
 */
const METRICS_SOURCE = 'Form';

(async () => {
  const { ghl } = await import('../lib/ghl/client');
  const { enumerateAllContacts } = await import('../lib/ghl/contacts');
  const { planSnapshot, snapshotKey } = await import('../lib/activities/sources/gatewayMetrics');
  const { upsertActivity } = await import('../lib/activities/upsert');
  const { checkCompanyIdentity } = await import('../lib/sync/identityGuard');
  const c = ghl();

  const extract = JSON.parse(readFileSync(join(process.cwd(), 'reports/gateway-metrics-rows.json'), 'utf8'));
  if (extract.problems?.length) {
    console.error('EXTRACTION PROBLEMS — fix these before importing:');
    for (const p of extract.problems) console.error(`   ${JSON.stringify(p)}`);
    process.exit(1);
  }
  let rows: GatewayRow[] = extract.rows;
  if (WORKBOOK) rows = rows.filter((r) => r.source_slug === WORKBOOK);
  if (LIMIT) rows = rows.slice(0, LIMIT);
  console.log(`rows to consider: ${rows.length}${WORKBOOK ? ` (workbook ${WORKBOOK})` : ' (ALL seven workbooks)'}`);
  console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply to write)\n');
  if (!rows.length) { console.error('no rows — check --workbook against the slugs in the extract'); process.exit(1); }

  const biz: any[] = []; let skip = 0;
  for (;;) {
    const d: any = await c.request({ path: '/businesses/', params: { limit: 100, skip } });
    const b = d.businesses ?? []; if (!b.length) break;
    biz.push(...b); if (b.length < 100) break; skip += 100;
  }
  const bizById = new Map<string, any>(biz.map((b: any) => [b.id, b]));
  const contacts = await enumerateAllContacts(c);
  const byEmail = new Map<string, any[]>();
  for (const ct of contacts as any[]) {
    if (!ct.email) continue;
    const k = String(ct.email).trim().toLowerCase();
    const a = byEmail.get(k) ?? []; a.push(ct); byEmail.set(k, a);
  }
  const { normalizeCompanyName, namesLookAlike } = await import('../lib/sync/identityGuard');
  const contactsFor = new Map<string, any[]>();
  for (const ct of contacts as any[]) {
    if (!ct.businessId) continue;
    const a = contactsFor.get(ct.businessId) ?? []; a.push(ct); contactsFor.set(ct.businessId, a);
  }
  const byName = new Map<string, any[]>();
  for (const b of biz) {
    const k = normalizeCompanyName(b.name);
    const a = byName.get(k) ?? []; a.push(b); byName.set(k, a);
  }

  /**
   * company id → period end → the snapshot already on file for it.
   *
   * This is the guard that makes a company-keyed import safe. A snapshot's real identity is
   * (company, period): one company reports once per half-year. The form path expresses that as
   * `<contactId>:<period>`, which works only when we know WHICH contact reported. When a row resolves
   * by company name and the company has several contacts, we do not know — so before writing anything
   * this index is consulted, and an existing snapshot for that company and period is UPDATED whatever
   * key it carries, rather than a second one being created beside it.
   *
   * Empty on the first run (live holds 0 metrics records). It earns its keep on every run after, and
   * on the day a real Client Reporting submission lands for a period this import already covered.
   */
  const snapshotOnFile = new Map<string, Map<string, { recordId: string; key: string }>>();
  {
    const { getRelatedRecordIds } = await import('../lib/ghl/associations');
    const acts: any[] = [];
    for (let page = 1; page <= 30; page += 1) {
      const d: any = await c.request({
        method: 'POST', path: '/objects/custom_objects.activities/records/search', autoLocation: false,
        body: { locationId: c.locationId, query: '', page, pageLimit: 100, searchAfter: [], sort: [{ field: 'updatedAt', direction: 'desc' }] },
      });
      const r = d.records ?? d.items ?? []; acts.push(...r); if (r.length < 100) break;
    }
    const metrics = acts.filter((a) => String(a.properties?.activity_type) === 'metrics');
    for (const a of metrics) {
      const period = String(a.properties?.reporting_period ?? '').slice(0, 10);
      if (!period) continue;
      const ids = await getRelatedRecordIds(a.id, 'business', c).catch(() => [] as string[]);
      for (const id of ids) {
        const m = snapshotOnFile.get(id) ?? new Map();
        m.set(period, { recordId: a.id, key: String(a.properties?.source_record_id ?? '') });
        snapshotOnFile.set(id, m);
      }
      await new Promise((r) => setTimeout(r, 110));
    }
    console.log(`existing metrics snapshots: ${metrics.length} (${snapshotOnFile.size} companies)`);
  }
  console.log(`indexed ${biz.length} companies, ${contacts.length} contacts\n`);

  const tally: Record<string, number> = {};
  const bump = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
  const review: any[] = [];
  const periodsSeen = new Map<string, number>();
  const created: string[] = [];

  for (const row of rows) {
    const plan = planSnapshot(row);
    if (!plan) { bump('skip:row-reports-nothing'); continue; }
    periodsSeen.set(plan.periodEnd, (periodsSeen.get(plan.periodEnd) ?? 0) + 1);

    // ── step 1: email → contact → company ───────────────────────────────────────────────────────
    let contact: any = null;
    let company: any = null;
    let how = '';
    const hits = row.email ? (byEmail.get(row.email) ?? []) : [];
    // More than one contact on an email is real (a shared inbox). Prefer one linked to a company,
    // since an unlinked duplicate cannot carry the snapshot anywhere.
    const emailContact = hits.find((h: any) => h.businessId) ?? hits[0] ?? null;
    if (emailContact?.businessId) {
      const b = bizById.get(emailContact.businessId);
      if (b) {
        // Does the workbook's company agree with the one the contact is linked to? A disagreement is
        // NOT resolved here: contact.businessId names where a person is NOW, and no similarity score
        // separates a rename from a job change.
        const idc = checkCompanyIdentity({
          contactCompanyName: row.company_name, contactWebsite: emailContact.website,
          companyName: b.name, companyWebsite: b.website,
        });
        if (idc.ok) { contact = emailContact; company = b; how = `email (${idc.verdict})`; }
        else {
          bump('review:company-name-disagrees');
          review.push({
            workbook: row.source_slug, row: row.row, company: row.company_name, email: row.email,
            linkedTo: b.name, companyId: b.id, why: idc.reason,
          });
          continue;
        }
      }
    }

    // ── step 2: company NAME, unique hit only ───────────────────────────────────────────────────
    if (!company && row.company_name) {
      const want = normalizeCompanyName(row.company_name);
      let cands = byName.get(want) ?? [];
      let via = 'name';
      if (!cands.length) {
        cands = biz.filter((b: any) => namesLookAlike(want, normalizeCompanyName(b.name)));
        via = 'name~';
      }
      if (cands.length === 1) {
        company = cands[0];
        const on = contactsFor.get(company.id) ?? [];
        // Exactly one contact: that is the person a real submission would come from, so the snapshot
        // can carry the form's own key and can never be duplicated by one. Several contacts: we do
        // not know which would report, and attaching a specific wrong person is worse than attaching
        // none — the company association is what a funder row is built from anyway.
        contact = on.length === 1 ? on[0] : null;
        how = `${via} (${on.length === 1 ? 'sole contact' : `${on.length} contacts — company-keyed`})`;
      } else if (cands.length > 1) {
        bump('review:name-matches-several-companies');
        review.push({
          workbook: row.source_slug, row: row.row, company: row.company_name, email: row.email,
          candidates: cands.map((b: any) => b.name).slice(0, 5),
          why: `the name matches ${cands.length} companies — a false positive here attaches the snapshot to the wrong business, invisibly`,
        });
        continue;
      }
    }

    if (!company) {
      bump(row.email ? (hits.length ? 'unresolved:contact-has-no-company' : 'unresolved:email-not-in-ghl') : 'unresolved:no-email');
      review.push({
        workbook: row.source_slug, row: row.row, company: row.company_name, email: row.email,
        why: !row.email
          ? 'the workbook records no email and no company of this name exists in GHL'
          : hits.length
            ? 'the contact exists but is not linked to a company, and no company of this name exists'
            : 'no contact has this email and no company of this name exists in GHL',
      });
      continue;
    }
    bump(`resolved:${how}`);

    // ── the company+period guard ────────────────────────────────────────────────────────────────
    // One company reports once per half-year. If a snapshot already exists for this company and
    // period under ANY key, update THAT record rather than creating a second one beside it — which is
    // the only way a follow-on-funding figure gets counted twice, and both rows look plausible.
    const onFile = snapshotOnFile.get(company.id)?.get(plan.periodEnd);
    const formKey = contact ? snapshotKey(contact.id, plan.periodEnd) : null;
    let sourceRecordId: string;
    if (onFile && (!formKey || onFile.key !== formKey)) {
      bump('guard:existing-snapshot-for-this-company-and-period');
      review.push({
        kind: 'guard', workbook: row.source_slug, row: row.row, company: row.company_name,
        recordId: onFile.recordId, existingKey: onFile.key,
        why: `this company already has a ${plan.periodEnd} snapshot under key ${onFile.key} — reusing it rather than writing a second one`,
      });
      sourceRecordId = onFile.key;
    } else if (formKey) {
      sourceRecordId = formKey;
    } else {
      // Company-keyed, with a prefix that CANNOT collide with a form key. The cardinality is still
      // exactly one per company per period, which is the real identity of a snapshot.
      sourceRecordId = `company:${company.id}:${plan.periodEnd}`;
      bump('note:company-keyed (no single contact to attribute it to)');
    }

    const res = await upsertActivity(
      { source: METRICS_SOURCE as any, sourceRecordId },
      { type: 'metrics', companyId: company.id, contactIds: contact ? [contact.id] : [], values: plan.values },
      {
        client: c, mode: 'ingest', actorKind: 'sync',
        actor: { name: 'activity:gateway-metrics-import' },
        // The period IS the record's meaning, and a real submission for the same period must be
        // free to correct the figures. Only the date the snapshot is filed under is set-once.
        onlyIfAbsent: ['activity_date'],
        plan: !APPLY,
      },
    );
    bump(`outcome:${res.outcome}`);
    if (res.outcome === 'would-update' || res.outcome === 'updated') {
      review.push({ kind: 'update', workbook: row.source_slug, row: row.row, company: row.company_name, recordId: res.recordId, fields: res.written });
    }
    if (res.outcome === 'created') created.push(res.recordId);
    await new Promise((r) => setTimeout(r, APPLY ? 320 : 90));
  }

  console.log('OUTCOMES:', JSON.stringify(tally, null, 1));
  console.log('\nperiods derived from these rows:');
  for (const [p, n] of Array.from(periodsSeen.entries()).sort()) console.log(`   ${p}   ${String(n).padStart(3)} row(s)`);
  if (APPLY) console.log(`\ncreated ${created.length} metrics record(s)`);

  const path = join(process.cwd(), 'reports/gateway-metrics-review.json');
  writeFileSync(path, JSON.stringify({ generatedAt: new Date().toISOString(), workbook: WORKBOOK ?? 'all', count: review.length, review }, null, 1));
  console.log(`\n${review.length} item(s) needing attention → reports/gateway-metrics-review.json`);
  for (const r of review.slice(0, 15)) {
    console.log(r.kind === 'update'
      ? `   ${r.workbook} row ${r.row}: ${String(r.company).slice(0, 32)} — would change ${r.fields?.join(', ')}`
      : `   ${r.workbook} row ${r.row}: ${String(r.company).slice(0, 32)} — ${r.why}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
