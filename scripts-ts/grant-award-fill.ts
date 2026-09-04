// scripts-ts/grant-award-fill.ts — fill `award_amount` and `award_date` on the grant activities.
// Dry-run by default (house rule).
//
//   npx vite-node scripts-ts/grant-award-fill.ts            # dry run + a source-agreement report
//   npx vite-node scripts-ts/grant-award-fill.ts --apply
//
// Zach, 2026-09-04: *"If you have good data for award amount and award date then go ahead and fill
// them in."* So this VALIDATES before it writes, and reports what it will not fill.
//
// ── award_amount ────────────────────────────────────────────────────────────────────────────────
// `opportunity.monetaryValue`, 64/64 populated. There is a published GHL workflow ("Copy Grant Value
// to Opportunity for Updated Approved Grants"), so the opportunity is the intended home for the
// approved figure. Cross-checked here against two independent witnesses — the contact's
// `score_total_grant_amount` and the amount LRL REPORTED on the funder spreadsheets — and a
// disagreement is reported rather than resolved silently.
//
// ── award_date ──────────────────────────────────────────────────────────────────────────────────
// This is the funder's "Date Direct Grant Awarded" (TC col S), so it must be the AWARD moment.
// Three candidate sources, in order of authority:
//
//   1. the funder spreadsheet's own grant date — 57 rows carry one, and it is the date LRL already
//      SUBMITTED. Nothing beats "the number we reported" for a compliance field.
//   2. `lastStageChangeAt` for an opportunity still sitting at **Receive Receipts** — that timestamp
//      is the moment it LEFT Execute Agreement, i.e. within days of the award.
//   3. nothing. An opportunity at **Closed Won** has `lastStageChangeAt` = when receipts were
//      accepted, weeks after the award, and GHL exposes no stage history to recover the real moment.
//
// ⚠️ Source 3 is left EMPTY, deliberately. An empty col S is a declared gap; a wrong award date is a
// compliance problem, and a plausible-looking wrong date is the failure this project treats as worst.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';

const APPLY = process.argv.includes('--apply');
// Local dev reads .env.local; in CI (GitHub Actions) the secrets arrive as real env vars and the
// file does not exist — an unguarded readFileSync ENOENTs the whole run before it starts.
function env() {
  try {
    const t = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const l of t.split('\n')) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env.local (CI) — env is already populated */ }
}

const STAGE: Record<string, string> = {
  '0dfd181d-1270-4fb2-81e9-99606b8fa216': 'Execute Agreement',
  '29569048-1326-489b-b658-4b7bebeba54b': 'Receive Receipts',
  '37c0eae6-c3cd-4b2c-b5bb-7cf56248da0b': 'Closed Won',
  'c08c538e-77e3-4408-8575-4c288569697d': 'Closed Lost',
};
/** The one stage whose lastStageChangeAt means "just left Execute Agreement". */
const RECEIPTS = '29569048-1326-489b-b658-4b7bebeba54b';
const blank = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
/** Cents-level agreement. The sheets were typed by hand, so a penny of drift is not a disagreement. */
const near = (a: number, b: number) => Math.abs(a - b) < 0.02;

async function main() {
  env(); process.env.GHL_TARGET = 'live';
  const c = ghl();
  console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply to write)\n');

  const { getCatalog } = await import('../lib/ghl/catalogCache');
  const { writeRecordFields } = await import('../lib/ghl/writeRecord');
  const { getRelatedRecordIds } = await import('../lib/ghl/associations');
  const { logChange } = await import('../lib/audit/log');
  const { normalizeCompanyName, namesLookAlike } = await import('../lib/sync/identityGuard');
  const catalog: any = await getCatalog('custom_objects.activities', { client: c });
  const contactCat: any = await getCatalog('contact', { client: c });

  // The funder spreadsheets: the amount and date LRL actually reported.
  const sheetRows: any[] = JSON.parse(readFileSync(join(process.cwd(), 'reports/sheet-rows.json'), 'utf8')).rows;
  const reported = sheetRows.filter((r) => r.grant_amount != null && r.grant_amount !== '' && r.grant_date);
  const byName = new Map<string, any[]>();
  for (const r of reported) {
    const k = normalizeCompanyName(r.business_name);
    const a = byName.get(k) ?? []; a.push(r); byName.set(k, a);
  }
  console.log(`funder-reported grants on the spreadsheets: ${reported.length}`);

  const biz: any[] = []; let skip = 0;
  for (;;) {
    const d: any = await c.request({ path: '/businesses/', params: { limit: 100, skip } });
    const b = d.businesses ?? []; if (!b.length) break;
    biz.push(...b); if (b.length < 100) break; skip += 100;
  }
  const bizById = new Map<string, any>(biz.map((b: any) => [b.id, b]));

  const acts: any[] = [];
  for (let page = 1; page <= 40; page += 1) {
    const d: any = await c.request({
      method: 'POST', path: '/objects/custom_objects.activities/records/search', autoLocation: false,
      body: { locationId: c.locationId, query: '', page, pageLimit: 100, searchAfter: [], sort: [{ field: 'updatedAt', direction: 'desc' }] },
    });
    const r = d.records ?? d.items ?? []; acts.push(...r); if (r.length < 100) break;
  }
  const grants = acts.filter((a: any) => String(a.properties?.activity_type) === 'grant');
  console.log(`grant activities: ${grants.length}\n`);

  const tally: Record<string, number> = {}; const bump = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
  const plan: any[] = []; const disagree: any[] = [];

  for (const a of grants) {
    const key = String(a.properties?.source_record_id ?? '');
    const oppId = key.endsWith(':grant') ? key.slice(0, -':grant'.length) : null;
    if (!oppId) { bump('skip:no-opportunity-in-source-key'); continue; }
    let opp: any = null;
    try { const d: any = await c.request({ path: `/opportunities/${oppId}` }); opp = d.opportunity ?? d; }
    catch { bump('skip:opportunity-gone'); continue; }

    // Witness 2: the contact's own total, which already key-matches and copies.
    let contactTotal: number | null = null;
    if (opp?.contactId) {
      try {
        const d: any = await c.request({ path: `/contacts/${opp.contactId}` });
        const ct = d.contact ?? d;
        for (const f of ct?.customFields ?? []) {
          const def = (contactCat.byId as any)?.[f.id];
          if (String(def?.fieldKey ?? '') === 'contact.score_total_grant_amount') {
            const n = Number(f.value ?? f.fieldValue); if (Number.isFinite(n)) contactTotal = n;
          }
        }
      } catch { /* a missing contact is not fatal to the amount */ }
    }

    // Witness 3: what we reported to the funder, matched on the activity's company.
    const companyIds = await getRelatedRecordIds(a.id, 'business', c).catch(() => [] as string[]);
    const companyName = companyIds.map((i) => bizById.get(i)?.name).filter(Boolean)[0] ?? null;
    let sheet: any = null;
    if (companyName) {
      const want = normalizeCompanyName(companyName);
      sheet = (byName.get(want) ?? [])[0]
        ?? reported.find((r) => namesLookAlike(want, normalizeCompanyName(r.business_name)))
        ?? null;
    }

    const mv = Number(opp?.monetaryValue);
    const amount = Number.isFinite(mv) && mv > 0 ? mv : null;

    // ── THE AMOUNT IS A VOTE, NOT A LOOKUP ────────────────────────────────────────────────────
    // Three independent witnesses: the opportunity (operational), the contact's own total (what the
    // application produced), and the amount LRL REPORTED to the funder. Measured 2026-09-04: they
    // disagree on 6 of 64, and on 3 of those the OPPORTUNITY is outvoted two-to-one
    // (Kem Bushi 5000 vs 4000+4000; Blue Entity 5800 vs 4002.29+4002.29; Chaloner's 20000 vs
    // 7500+7500). Taking `monetaryValue` on faith would have written a wrong figure into a
    // funder-reportable field on those three — and it would have looked fine, because the field was
    // empty before and any number is an improvement on nothing.
    //
    // So: the value with the most agreeing witnesses wins, ties break toward the opportunity, and
    // EVERY disagreement is reported whether or not it changed the answer. A record where all three
    // differ has no majority and is left for a person.
    const witnesses = [
      ['opportunity.monetaryValue', amount],
      ['contact.score_total_grant_amount', contactTotal],
      ['funder sheet (as reported)', sheet ? Number(sheet.grant_amount) : null],
    ].filter(([, v]) => v != null) as Array<[string, number]>;

    let voted: number | null = amount;
    let votedBy: string[] = amount != null ? ['opportunity.monetaryValue'] : [];
    let agree = true;
    if (witnesses.length >= 2) {
      const buckets: Array<{ value: number; by: string[] }> = [];
      for (const [name, v] of witnesses) {
        const hit = buckets.find((b) => near(b.value, v));
        if (hit) hit.by.push(name); else buckets.push({ value: v, by: [name] });
      }
      agree = buckets.length === 1;
      if (!agree) {
        // Prefer the largest bucket; on a tie prefer the one containing the opportunity.
        buckets.sort((x, y) => y.by.length - x.by.length
          || Number(y.by.includes('opportunity.monetaryValue')) - Number(x.by.includes('opportunity.monetaryValue')));
        const top = buckets[0];
        const tied = buckets.filter((b) => b.by.length === top.by.length).length > 1;
        if (tied && top.by.length === 1) {
          // No majority at all — three witnesses, three answers. Not ours to pick.
          voted = null; votedBy = [];
          bump('amount:no-majority — left for review');
        } else {
          voted = top.value; votedBy = top.by;
        }
        disagree.push({
          activityId: a.id, name: String(a.properties?.activity_name ?? '').slice(0, 42),
          witnesses: Object.fromEntries(witnesses),
          chose: voted, chosenBy: votedBy,
          overrodeOpportunity: voted != null && amount != null && !near(voted, amount),
        });
        bump('amount:witnesses-disagree');
      } else {
        votedBy = witnesses.map(([n]) => n);
      }
    }

    // Date, by authority.
    const stageId = String(opp?.pipelineStageId ?? '');
    let date: string | null = null; let dateSource = '';
    if (sheet?.grant_date) { date = String(sheet.grant_date).slice(0, 10); dateSource = 'funder sheet (as reported)'; }
    else if (stageId === RECEIPTS && opp?.lastStageChangeAt) {
      date = String(opp.lastStageChangeAt).slice(0, 10); dateSource = 'left Execute Agreement';
    }
    if (!date) bump(`date:unrecoverable (${STAGE[stageId] ?? stageId})`);

    const current = {
      amount: a.properties?.award_amount, date: String(a.properties?.award_date ?? '').slice(0, 10),
    };
    const changes: Record<string, unknown> = {};
    // Only fill what is EMPTY. A figure already on the record was put there by someone, and this
    // script is closing a 0/64 gap, not overriding judgement.
    if (voted != null && blank(current.amount)) changes.award_amount = voted;
    if (date && !current.date) changes.award_date = date;
    if (!Object.keys(changes).length) { bump('noop'); continue; }

    plan.push({
      activityId: a.id, name: String(a.properties?.activity_name ?? '').slice(0, 42),
      company: companyName, stage: STAGE[stageId] ?? stageId,
      ...changes, dateSource: changes.award_date ? dateSource : undefined,
      amountWitnesses: witnesses.length, amountAgree: agree, amountFrom: votedBy,
    });
    bump(changes.award_amount != null && changes.award_date ? 'fill:amount+date'
      : changes.award_amount != null ? 'fill:amount-only' : 'fill:date-only');
    await new Promise((r) => setTimeout(r, 140));
  }

  console.log('OUTCOMES:', JSON.stringify(tally, null, 1));
  const withDate = plan.filter((p) => p.award_date);
  console.log(`\n${plan.length} record(s) would be filled — ${withDate.length} with a date:`);
  for (const p of plan.slice(0, 18)) {
    console.log(`   ${String(p.name).padEnd(44)} $${p.award_amount ?? '—'}  ${p.award_date ?? '(no date)'}  ${p.dateSource ?? ''}`);
  }
  if (plan.length > 18) console.log(`   …and ${plan.length - 18} more`);
  console.log(`\ndate source breakdown:`);
  const bySrc: Record<string, number> = {};
  for (const p of plan) { const k = p.dateSource ?? 'left empty (no recoverable award moment)'; bySrc[k] = (bySrc[k] ?? 0) + 1; }
  for (const [k, n] of Object.entries(bySrc)) console.log(`   ${String(n).padStart(3)}  ${k}`);

  if (disagree.length) {
    console.log(`\n⚠️  ${disagree.length} record(s) where the amount witnesses DISAGREE — majority taken, CHECK THESE:`);
    for (const d of disagree.slice(0, 12)) {
      console.log(`   ${d.name.padEnd(44)} ${JSON.stringify(d.witnesses)}`);
      console.log(`      → wrote ${d.chose ?? '(nothing — no majority)'}${d.chosenBy?.length ? ` on ${d.chosenBy.join(' + ')}` : ''}${d.overrodeOpportunity ? '   ⚠️ OVERRODE the opportunity' : ''}`);
    }
  } else {
    console.log('\n✅ every record with two or more amount witnesses had them agree to the cent');
  }

  writeFileSync(join(process.cwd(), 'reports/grant-award-fill.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), mode: APPLY ? 'apply' : 'dry-run', plan, disagree }, null, 1));
  console.log('\n→ reports/grant-award-fill.json');
  if (!APPLY) { console.log('nothing written.'); return; }

  let wrote = 0;
  for (const p of plan) {
    const changes: Record<string, unknown> = {};
    if (p.award_amount != null) changes.award_amount = p.award_amount;
    if (p.award_date) changes.award_date = p.award_date;
    const res = await writeRecordFields('custom_objects.activities', p.activityId, changes, catalog, c);
    if (res.written.length) {
      wrote += 1;
      await logChange({
        objectType: 'custom_objects.activities', recordId: p.activityId, recordLabel: p.name,
        actorKind: 'sync', actorName: 'grant-award-fill', action: 'update',
        changes: res.written.map((k) => ({ field: `custom_objects.activities.${k}`, from: undefined, to: (changes as any)[k], source: 'Opportunity Stage' as const })),
        method: p.dateSource ? `amount: opportunity.monetaryValue; date: ${p.dateSource}` : 'amount: opportunity.monetaryValue',
        rationale: `amount from ${(p.amountFrom ?? []).join(' + ') || 'opportunity'}; ${p.amountWitnesses} witness(es), ${p.amountAgree ? 'agreeing' : 'DISAGREEING (majority taken)'}`,
        applied: true,
      }).catch(() => {});
    } else {
      console.log(`   NOT WRITTEN: ${p.activityId} ${JSON.stringify(res.skipped)}`);
    }
    await new Promise((r) => setTimeout(r, 320));
  }
  console.log(`\nwrote ${wrote}/${plan.length} record(s)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
