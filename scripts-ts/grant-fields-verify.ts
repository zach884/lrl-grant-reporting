// READ-ONLY. Did the alias table and the enricher actually land on live?
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
// Local dev reads .env.local; in CI the secrets are real env vars and the file does not exist.
function env(){ try {
  const t=readFileSync(join(process.cwd(),'.env.local'),'utf8');
  for(const l of t.split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');}
} catch { /* CI */ } }
const blank=(v:unknown)=>v==null||v===''||(Array.isArray(v)&&v.length===0);
async function main(){
  env(); process.env.GHL_TARGET='live';
  const c=ghl();
  const acts:any[]=[];
  for(let page=1;page<=40;page+=1){
    const d:any=await c.request({method:'POST',path:'/objects/custom_objects.activities/records/search',autoLocation:false,
      body:{locationId:c.locationId,query:'',page,pageLimit:100,searchAfter:[],sort:[{field:'updatedAt',direction:'desc'}]}});
    const r=d.records??d.items??[]; acts.push(...r); if(r.length<100)break;
  }
  const g=acts.filter((a:any)=>String(a.properties?.activity_type)==='grant');
  console.log(`grant activities: ${g.length}\n`);
  const FIELDS=['grant_reason','grant_program','expense_category_item_3','award_amount','award_date','activity_date','grant_status'];
  console.log('population (was 0/64 on the first four of these on 2026-09-03):');
  for(const f of FIELDS){
    const n=g.filter((a:any)=>!blank(a.properties?.[f])).length;
    console.log(`   ${String(n).padStart(3)}/${g.length}  ${'█'.repeat(Math.round(n/g.length*20)).padEnd(20)} ${f}`);
  }
  const prog:Record<string,number>={};
  for(const a of g){const v=String(a.properties?.grant_program??'(empty)');prog[v]=(prog[v]??0)+1;}
  console.log('\ngrant_program values now on the records:');
  for(const [k,v] of Object.entries(prog).sort((a,b)=>b[1]-a[1])) console.log(`   ${String(v).padStart(3)}  ${k}`);
  const withReason=g.filter((a:any)=>!blank(a.properties?.grant_reason));
  const bad=withReason.filter((a:any)=>/\$|vendor|will help|great |excellent/i.test(String(a.properties?.grant_reason)));
  console.log(`\nreasons breaking a prompt rule (dollar figure / vendor / outcome / praise): ${bad.length}/${withReason.length}`);
  for(const a of bad.slice(0,5)) console.log(`   ${String(a.properties?.activity_name).slice(0,40)}: ${String(a.properties?.grant_reason).slice(0,90)}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
