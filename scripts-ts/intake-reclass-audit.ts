// scripts-ts/intake-reclass-audit.ts — READ-ONLY. Sizes two corrections Zach called for 9/2:
//
//  RULE 1  "anytime you see notes about referrals or intros to be made, it's safe to assume it was an
//           intake meeting, unless we have already logged an intake meeting with the company."
//  RULE 2  the leadconnectorhq /proposals link in a row's notes is the EXECUTED GRANT CONTRACT, not
//           meeting content — so it must not mark the date `exact`, and it does not belong in the
//           notes of a technical-assistance record.
//
// Writes reports/intake-reclass.json so the plan is reviewable before anything is applied.
//   npx vite-node scripts-ts/intake-reclass-audit.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
import { getRelatedRecordIds } from '../lib/ghl/associations';

function env() {
  const t = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
  for (const l of t.split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const DOC_LINK = /leadconnectorhq\.com/i;
/** Zach's rule-1 signal: the notes describe a referral or an introduction. */
const REFERRAL_TALK = /refer(r(ed|al|ing)|s)?\b|introduc(e|ed|ing|tion)|\bintro\b|put (him|her|them) in touch/i;
/** …but a cohort interview is not an intake, and "intro call" for one is not a referral. */
const COHORT_INTERVIEW = /cohort interview/i;

async function main() {
  env(); process.env.GHL_TARGET = 'live';
  const c = ghl();

  const biz: any[] = []; let skip = 0;
  for (;;) {
    const d: any = await c.request({ path: '/businesses/', params: { limit: 100, skip } });
    const b = d.businesses ?? []; if (!b.length) break;
    biz.push(...b); if (b.length < 100) break; skip += 100;
  }
  const bizName = new Map<string, string>(biz.map((b: any) => [b.id, b.name]));

  const acts: any[] = [];
  for (let page = 1; page <= 30; page += 1) {
    const d: any = await c.request({
      method: 'POST', path: '/objects/custom_objects.activities/records/search', autoLocation: false,
      body: { locationId: c.locationId, query: '', page, pageLimit: 100, searchAfter: [], sort: [{ field: 'updatedAt', direction: 'desc' }] },
    });
    const r = d.records ?? d.items ?? [];
    acts.push(...r); if (r.length < 100) break;
  }

  // Resolve each activity's company once.
  const rows: any[] = [];
  for (const a of acts) {
    const p = a.properties ?? {};
    const ids = await getRelatedRecordIds(a.id, 'business', c).catch(() => [] as string[]);
    rows.push({
      id: a.id,
      type: String(p.activity_type ?? ''),
      source: String(p.activity_source ?? ''),
      sourceId: String(p.source_record_id ?? ''),
      date: String(p.activity_date ?? '').slice(0, 10),
      name: String(p.activity_name ?? ''),
      notes: String(p.activity_notes ?? ''),
      companyIds: ids,
    });
    await new Promise((r) => setTimeout(r, 110));
  }
  console.log(`${biz.length} companies, ${rows.length} activities\n`);

  // Which companies already have an intake logged, and from where.
  const intakeByCompany = new Map<string, any[]>();
  for (const r of rows) {
    if (r.type !== 'intake') continue;
    for (const id of r.companyIds) {
      const a = intakeByCompany.get(id) ?? []; a.push(r); intakeByCompany.set(id, a);
    }
  }
  console.log(`companies with an intake already logged: ${intakeByCompany.size}`);

  const sheetTa = rows.filter((r) => r.type === 'technical_assistance' && /^(tc-cumulative|sbsh-companies):/.test(r.sourceId));
  console.log(`sheet-imported technical_assistance records: ${sheetTa.length}\n`);

  const grantNote = sheetTa.filter((r) => DOC_LINK.test(r.notes));
  const referralTalk = sheetTa.filter((r) => !DOC_LINK.test(r.notes) && REFERRAL_TALK.test(r.notes) && !COHORT_INTERVIEW.test(r.notes));
  const cohort = sheetTa.filter((r) => !DOC_LINK.test(r.notes) && COHORT_INTERVIEW.test(r.notes));
  const blank = sheetTa.filter((r) => !r.notes.replace(/\[imported from[^\]]*\]/g, '').trim());

  const label = (r: any) => r.companyIds.map((i: string) => bizName.get(i) ?? i).join(', ') || '(contact-only)';
  const hasIntake = (r: any) => r.companyIds.some((i: string) => intakeByCompany.has(i));

  const reclass = referralTalk.filter((r) => !hasIntake(r));
  const held = referralTalk.filter(hasIntake);

  console.log('── RULE 1: notes describe a referral/intro ──');
  console.log(`   candidates                      ${referralTalk.length}`);
  console.log(`   company already has an intake   ${held.length}   <-- leave as technical assistance`);
  console.log(`   RECLASSIFY to intake            ${reclass.length}\n`);
  for (const r of reclass) {
    console.log(`   ${r.date}  ${label(r).slice(0, 34).padEnd(34)}  ${r.notes.replace(/\s+/g, ' ').slice(0, 74)}`);
  }
  if (held.length) {
    console.log('\n   held back (intake already on file):');
    for (const r of held) {
      const on = r.companyIds.flatMap((i: string) => intakeByCompany.get(i) ?? []).map((x: any) => `${x.date}/${x.source}`).join(' ');
      console.log(`   ${r.date}  ${label(r).slice(0, 34).padEnd(34)}  existing intake: ${on}`);
    }
  }

  console.log(`\n── cohort interviews (matched the words, are NOT referrals): ${cohort.length} ──`);
  for (const r of cohort) console.log(`   ${r.date}  ${label(r).slice(0, 34).padEnd(34)}  ${r.name}`);

  console.log(`\n── RULE 2: notes are an executed grant contract: ${grantNote.length} ──`);
  const wrongDate = grantNote.filter((r) => !/date approximate/.test(r.notes));
  console.log(`   wrongly marked as an exact date: ${wrongDate.length}`);
  console.log(`   company already has a grant activity:`);
  const grantByCompany = new Set<string>();
  for (const r of rows) if (r.type === 'grant') for (const i of r.companyIds) grantByCompany.add(i);
  const covered = grantNote.filter((r) => r.companyIds.some((i: string) => grantByCompany.has(i)));
  console.log(`      ${covered.length} of ${grantNote.length}`);
  for (const r of grantNote.slice(0, 8)) console.log(`   ${r.date}  ${label(r).slice(0, 34).padEnd(34)}  grant on file: ${r.companyIds.some((i: string) => grantByCompany.has(i)) ? 'yes' : 'NO'}`);

  console.log(`\n── unclassifiable: sheet TA with no notes at all: ${blank.length} ──`);
  const blankNoIntake = blank.filter((r) => !hasIntake(r));
  console.log(`   of those, company has no intake on file: ${blankNoIntake.length}`);

  mkdirSync(join(process.cwd(), 'reports'), { recursive: true });
  writeFileSync(join(process.cwd(), 'reports/intake-reclass.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    totals: { activities: rows.length, sheetTa: sheetTa.length, companiesWithIntake: intakeByCompany.size },
    rule1: { reclassify: reclass, heldBecauseIntakeExists: held, cohortInterviews: cohort },
    rule2: { grantContractNotes: grantNote, wronglyExactDate: wrongDate.length },
    blankNotes: blank,
  }, null, 2));
  console.log('\nwrote reports/intake-reclass.json');
}
main().catch((e) => { console.error(e); process.exit(1); });
