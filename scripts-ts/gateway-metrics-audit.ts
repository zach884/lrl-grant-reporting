// READ-ONLY. Does live actually hold what the import claimed? Checks the brief's acceptance
// criteria against the records themselves rather than against the run's own tally.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
// Local dev reads .env.local; in CI (GitHub Actions) the secrets arrive as real env vars and the
// file does not exist — an unguarded readFileSync ENOENTs the whole run before it starts.
function env(){
  try {
    const t = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const l of t.split('\n')) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env.local (CI) — env is already populated */ }
}
const EXPECTED=['2023-02-28','2023-08-31','2024-02-29','2024-08-31','2025-02-28','2025-08-31','2026-02-28'];
async function main(){
  env(); process.env.GHL_TARGET='live';
  const c=ghl();
  const acts:any[]=[];
  for(let page=1;page<=40;page+=1){
    const d:any=await c.request({method:'POST',path:'/objects/custom_objects.activities/records/search',autoLocation:false,
      body:{locationId:c.locationId,query:'',page,pageLimit:100,searchAfter:[],sort:[{field:'updatedAt',direction:'desc'}]}});
    const r=d.records??d.items??[]; acts.push(...r); if(r.length<100)break;
  }
  const m=acts.filter((a:any)=>String(a.properties?.activity_type)==='metrics');
  console.log(`total activities: ${acts.length}    metrics: ${m.length}\n`);
  const byPeriod=new Map<string,any[]>();
  for(const a of m){const p=String(a.properties?.reporting_period??'').slice(0,10);
    const x=byPeriod.get(p)??[];x.push(a);byPeriod.set(p,x);}
  console.log('metrics by reporting_period:');
  for(const [p,rows] of Array.from(byPeriod.entries()).sort()){
    const tag = EXPECTED.includes(p) ? 'Gateway import' : p==='2026-08-31' ? 'LIVE submission' : '??';
    console.log(`   ${p}   ${String(rows.length).padStart(3)}   ${tag}`);
  }
  const missing=EXPECTED.filter((p)=>!byPeriod.has(p));
  console.log(`\nall seven expected periods present: ${missing.length===0}${missing.length?`  MISSING ${missing.join(', ')}`:''}`);
  const live=byPeriod.get('2026-08-31')??[];
  console.log(`the live 2026-08-31 snapshot: ${live.length} record(s) — untouched by the import: ${live.every((a:any)=>!/Gateway semi-annual/.test(String(a.properties?.activity_notes??'')))}`);

  // Field population across the imported records, and the bank-loan field specifically.
  const imported=m.filter((a:any)=>/Gateway semi-annual/.test(String(a.properties?.activity_notes??'')));
  console.log(`\nimported records: ${imported.length}`);
  const FIELDS=['jobs_created_in_the_last_6_months','jobs_retained_in_the_last_6_months',
    'number_of_new_products_commercialized_in_the_last_6_months','number_of_products_in_the_commercialization_pipeline',
    'medc_funding_received_in_the_last_6_months','federal_funding_including_sbir_and_sttr_received_in_the_last_6_months',
    'venture_capital_funding_received_in_the_last_6_months','angle_investor_funding_received_in_the_last_6_months',
    'bank_loans_received_in_the_last_6_months','owner_investment_in_the_last_6_months',
    'new_sales_in_the_last_6_months','other_funding_received_in_the_last_6_months','describe_other_funding_received'];
  console.log('population (non-blank) per field:');
  for(const f of FIELDS){
    const n=imported.filter((a:any)=>{const v=a.properties?.[f]; return v!==undefined&&v!==null&&v!=='';}).length;
    const bar='█'.repeat(Math.round(n/imported.length*22));
    console.log(`   ${String(n).padStart(3)}/${imported.length}  ${bar.padEnd(22)} ${f}`);
  }
  // Duplicate check: one company must not hold two snapshots for one period.
  const { getRelatedRecordIds } = await import('../lib/ghl/associations');
  const seen=new Map<string,string[]>();
  for(const a of m){
    const p=String(a.properties?.reporting_period??'').slice(0,10);
    const ids=await getRelatedRecordIds(a.id,'business',c).catch(()=>[] as string[]);
    for(const id of ids){const k=`${id}|${p}`; const x=seen.get(k)??[];x.push(a.id);seen.set(k,x);}
    await new Promise((r)=>setTimeout(r,110));
  }
  const dupes=Array.from(seen.entries()).filter(([,v])=>v.length>1);
  console.log(`\nDUPLICATE AUDIT — company+period pairs holding more than one snapshot: ${dupes.length}`);
  for(const [k,v] of dupes.slice(0,10)) console.log(`   ${k}  ->  ${v.join(', ')}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
