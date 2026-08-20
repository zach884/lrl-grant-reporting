// scripts-ts/form-ingest-run.ts — backfill Grant / Metrics activities from the contact fields the
// GHL forms wrote.
//
// The pipeline gives a grant its record and its status; the FORM carries the ~44 detail fields, and
// those live on the contact. This walks the contacts that hold answers and merges them onto the
// grant record the pipeline already created — the two sources converge on ONE record because the
// grant's identity is its opportunity.
//
//   npx vite-node scripts-ts/form-ingest-run.ts grant            # dry run
//   npx vite-node scripts-ts/form-ingest-run.ts grant --apply
//   npx vite-node scripts-ts/form-ingest-run.ts metrics [--apply] [--submitted 2026-03-10]
//
// ⚠️ For grants every outcome should be `updated` or `noop`. A `created` means the form did not
// resolve the contact's Direct Grants opportunity, so it made a standalone record — review those.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';

const KIND = (process.argv[2] ?? 'grant') as 'grant' | 'metrics';
const APPLY = process.argv.includes('--apply');
const submittedIdx = process.argv.indexOf('--submitted');
const SUBMITTED = submittedIdx >= 0 ? process.argv[submittedIdx + 1] : undefined;

const FORMS = {
  grant: { id: '0d8irJ6Ay6VQFajG06Go', label: 'Direct Grant Application', probe: /score_total_grant_amount|total_grant_amount/ },
  metrics: { id: 'ed03BbRGWrc6Ugtwr9JB', label: 'Client Reporting Form', probe: /jobs_created_in_the_last_6_months|number_of_full_time_equivalents_fte/ },
} as const;

(async () => {
  const { ghl } = await import('../lib/ghl/client');
  const { getContactFieldCatalog } = await import('../lib/ghl/customFields');
  const { ingestFormSubmission } = await import('../lib/activities/sources/form');
  const c = ghl();
  const form = FORMS[KIND];

  const cat = await getContactFieldCatalog(c);
  const probeIds = new Set(cat.fields.filter((f) => form.probe.test(f.fieldKey)).map((f) => f.id));
  if (!probeIds.size) throw new Error(`no probe field found for ${KIND}`);

  // Which contacts actually answered this form?
  const targets: Array<{ id: string; name: string }> = [];
  let url: string | undefined;
  for (let page = 0; page < 15; page++) {
    const data: any = url
      ? await c.request({ path: url.replace('https://services.leadconnectorhq.com', ''), autoLocation: false })
      : await c.request({ path: '/contacts/', params: { locationId: c.locationId, limit: '100' } });
    const batch: any[] = data.contacts ?? [];
    if (!batch.length) break;
    for (const ct of batch) {
      const has = (ct.customFields ?? []).some((f: any) => probeIds.has(f.id) && f.value != null && f.value !== '' && !(Array.isArray(f.value) && !f.value.length));
      if (has) targets.push({ id: ct.id, name: ct.contactName ?? ct.id });
    }
    url = data.meta?.nextPageUrl;
    if (!url) break;
  }

  console.log(`${form.label}: ${targets.length} contact(s) hold answers`);
  console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply to write)\n');

  const tally: Record<string, number> = {};
  const bump = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
  const standalone: string[] = [];

  for (const t of targets) {
    const r = await ingestFormSubmission({ contactId: t.id, formId: form.id }, { client: c, dryRun: !APPLY, submittedAt: SUBMITTED });
    const outcome = r.status === 'ingested' ? (r.activity?.outcome ?? 'would-write') : `skip:${r.reason}`;
    bump(outcome);
    if (outcome === 'created' && KIND === 'grant') standalone.push(`  ${t.name} — ${r.detail ?? ''}`);
    if (!APPLY && r.detail) console.log(`  ${t.name.slice(0, 34).padEnd(36)} ${String(r.copied ?? 0).padStart(2)} field(s)  ${r.detail.slice(0, 80)}`);
    await new Promise((res) => setTimeout(res, 320));
  }

  console.log('\nOUTCOMES:', JSON.stringify(tally, null, 1));
  if (standalone.length) {
    console.log(`\n⚠️  ${standalone.length} grant(s) created STANDALONE — no Direct Grants opportunity matched, so they did not merge:`);
    for (const s of standalone.slice(0, 15)) console.log(s);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
