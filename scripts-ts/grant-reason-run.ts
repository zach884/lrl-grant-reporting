// scripts-ts/grant-reason-run.ts — derive grant_reason on the grant activities from their approved
// line items. DRY-RUN by default (house rule); --apply writes, and requires --yes.
//
//   npx vite-node scripts-ts/grant-reason-run.ts --limit 5            # DRY RUN a sample, prints the text
//   npx vite-node scripts-ts/grant-reason-run.ts                      # DRY RUN all
//   npx vite-node scripts-ts/grant-reason-run.ts --apply --yes
//   npx vite-node scripts-ts/grant-reason-run.ts --only <recordId>
//
// Why an enricher and not a field copy: the application's own "how will you use the funds" answer is
// on only 17 of 64 contacts, while the approved line items are on 54 — and the line items are what
// was contractually agreed rather than what was requested, so an amended agreement moves them.
// See lib/enrichment/enrichers/grantReason.ts for the full reasoning.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';

const APPLY = process.argv.includes('--apply');
const YES = process.argv.includes('--yes');
const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const LIMIT = Number(arg('--limit') ?? 0) || 0;
const ONLY = arg('--only');
const OVERWRITE = process.argv.includes('--overwrite');

function env(){const t=readFileSync(join(process.cwd(),'.env.local'),'utf8');
 for(const l of t.split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');}}

async function main(){
  env(); process.env.GHL_TARGET='live';
  if (APPLY && !YES) { console.error('--apply also needs --yes (this writes to live)'); process.exit(1); }
  const c=ghl();
  console.log(APPLY?'MODE: APPLY\n':'MODE: DRY RUN (pass --apply --yes to write)\n');

  const { hasAnthropic } = await import('../lib/ai/anthropic');
  if (!hasAnthropic) { console.error('no ANTHROPIC_API_KEY in .env.local — the enricher cannot run'); process.exit(1); }
  const { grantReasonEnricher, readLineItems, GRANT_REASON_FIELD } = await import('../lib/enrichment/enrichers/grantReason');
  const { getCatalog } = await import('../lib/ghl/catalogCache');
  const { readRecordFields } = await import('../lib/ghl/records');
  const { writeRecordFields } = await import('../lib/ghl/writeRecord');
  const { logChange } = await import('../lib/audit/log');
  const catalog:any = await getCatalog('custom_objects.activities',{client:c});

  const acts:any[]=[];
  for(let page=1;page<=40;page+=1){
    const d:any=await c.request({method:'POST',path:'/objects/custom_objects.activities/records/search',autoLocation:false,
      body:{locationId:c.locationId,query:'',page,pageLimit:100,searchAfter:[],sort:[{field:'updatedAt',direction:'desc'}]}});
    const r=d.records??d.items??[]; acts.push(...r); if(r.length<100)break;
  }
  let grants=acts.filter((a:any)=>String(a.properties?.activity_type)==='grant');
  if (ONLY) grants=grants.filter((a:any)=>a.id===ONLY);
  if (LIMIT) grants=grants.slice(0,LIMIT);
  console.log(`grant activities to consider: ${grants.length}\n`);

  const tally:Record<string,number>={}; const bump=(k:string)=>{tally[k]=(tally[k]??0)+1;};
  const out:any[]=[];

  for(const a of grants){
    const name=String(a.properties?.activity_name??'').slice(0,46);
    // Read through readRecordFields so the enricher sees the same shape the engine would give it.
    const fields=await readRecordFields('custom_objects.activities',a.id,c);
    const field=(k:string)=>fields.get(k);
    const existing=String(field(GRANT_REASON_FIELD)??'').trim();
    if (existing && !OVERWRITE) { bump('skip:already-has-a-reason'); continue; }

    const items=readLineItems(field);
    if(!items.length){ bump('skip:no-line-items'); out.push({recordId:a.id,name,skipped:'no line items on the record'}); continue; }

    const proposals=await grantReasonEnricher.enrich({objectKey:'custom_objects.activities',recordId:a.id,catalog,field});
    if(!proposals.length){ bump('skip:enricher-declined'); continue; }
    const p=proposals[0];
    bump(`proposed:${p.provenance.confidence>=0.9?'high':p.provenance.confidence>=0.6?'medium':'low'}`);
    out.push({recordId:a.id,name,items:items.length,total:items.reduce((s,i)=>s+i.amount,0),
      reason:String(p.value),confidence:p.provenance.confidence,rationale:p.provenance.rationale,was:existing||null});
    console.log(`${name}\n   ${items.length} item(s), $${items.reduce((s,i)=>s+i.amount,0).toLocaleString('en-US')}  conf=${p.provenance.confidence}`);
    console.log(`   → ${String(p.value)}\n`);

    if(APPLY){
      const res=await writeRecordFields('custom_objects.activities',a.id,{[GRANT_REASON_FIELD]:p.value},catalog,c);
      bump(res.written.length?'written':'write-skipped');
      if(res.written.length){
        await logChange({objectType:'custom_objects.activities',recordId:a.id,recordLabel:name,
          actorKind:'enricher',actorName:'grant-reason',action:'update',
          changes:[{field:`custom_objects.activities.${GRANT_REASON_FIELD}`,from:existing||undefined,to:p.value,source:'Manual'}],
          method:p.provenance.method,confidence:p.provenance.confidence,rationale:p.provenance.rationale,applied:true}).catch(()=>{});
      }
      await new Promise((r)=>setTimeout(r,320));
    }
  }

  console.log('OUTCOMES:',JSON.stringify(tally,null,1));
  mkdirSync(join(process.cwd(),'reports'),{recursive:true});
  writeFileSync(join(process.cwd(),'reports/grant-reason-run.json'),
    JSON.stringify({generatedAt:new Date().toISOString(),mode:APPLY?'apply':'dry-run',count:out.length,rows:out},null,1));
  console.log('\n→ reports/grant-reason-run.json');
}
main().catch(e=>{console.error(e);process.exit(1);});
