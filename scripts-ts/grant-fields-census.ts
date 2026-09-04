// READ-ONLY. The grant headline fields, measured before anything is built.
//
// Answers, per the brief docs/sprints/grant-headline-fields.md:
//   - are award_amount / award_date / grant_program / grant_reason really empty on all 63?
//   - what does each grant's OPPORTUNITY carry (monetaryValue, stage, lastStageChangeAt)?
//   - what does each grant's CONTACT carry for the two alias fields, and how many are BAF?
//   - can an "Agreement Executed" moment be recovered at all?
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

const HEADLINE = ['award_amount','award_date','grant_program','grant_reason'];
const REASON_KEY = 'please_do_into_detail_on_how_you_will_specifically_utilize_the_funds_if_awarded_a_direct_grant';

async function main(){
  env(); process.env.GHL_TARGET='live';
  const c=ghl();
  const acts:any[]=[];
  for(let page=1;page<=40;page+=1){
    const d:any=await c.request({method:'POST',path:'/objects/custom_objects.activities/records/search',autoLocation:false,
      body:{locationId:c.locationId,query:'',page,pageLimit:100,searchAfter:[],sort:[{field:'updatedAt',direction:'desc'}]}});
    const r=d.records??d.items??[]; acts.push(...r); if(r.length<100)break;
  }
  const grants=acts.filter((a:any)=>String(a.properties?.activity_type)==='grant');
  console.log(`grant activities: ${grants.length}\n`);

  const blank=(v:unknown)=>v==null||v===''||(Array.isArray(v)&&v.length===0);
  console.log('headline field population TODAY:');
  for(const f of [...HEADLINE,'grant_status','score_total_grant_amount','activity_date','program__grant_association']){
    const n=grants.filter((a:any)=>!blank(a.properties?.[f])).length;
    console.log(`   ${String(n).padStart(3)}/${grants.length}  ${f}`);
  }

  // The source key is `<oppId>:grant`, so the opportunity id is recoverable from the record itself.
  const rows:any[]=[];
  const { getCatalog } = await import('../lib/ghl/catalogCache');
  const contactCat:any = await getCatalog('contact',{client:c});
  const idOf=(k:string)=>Object.values(contactCat.byId??{}).length?undefined:undefined;

  for(const a of grants){
    const key=String(a.properties?.source_record_id??'');
    const oppId=key.endsWith(':grant')?key.slice(0,-':grant'.length):null;
    let opp:any=null;
    if(oppId){ try{ const d:any=await c.request({path:`/opportunities/${oppId}`}); opp=d.opportunity??d; }catch{ opp=null; } }
    const contactId=opp?.contactId ?? opp?.contact?.id ?? null;
    let contact:any=null;
    if(contactId){ try{ const d:any=await c.request({path:`/contacts/${contactId}`}); contact=d.contact??d; }catch{ contact=null; } }
    const cf=new Map<string,any>();
    for(const f of (contact?.customFields??[])){
      const def=(contactCat.byId as any)?.[f.id];
      const bare=String(def?.fieldKey??'').replace(/^contact\./,'');
      if(bare) cf.set(bare, f.value ?? f.fieldValue);
    }
    rows.push({
      activityId:a.id, name:String(a.properties?.activity_name??''), key,
      oppId, oppStage:opp?.pipelineStageId??null, oppStatus:opp?.status??null,
      monetaryValue:opp?.monetaryValue??null,
      lastStageChangeAt:opp?.lastStageChangeAt??null,
      contactId,
      direct_grant_program:cf.get('direct_grant_program')??null,
      grant_reason_src:cf.get(REASON_KEY)??null,
      total_grant_amount:cf.get('score_total_grant_amount')??null,
    });
    await new Promise((r)=>setTimeout(r,140));
  }

  const have=(f:string)=>rows.filter((r)=>!blank(r[f])).length;
  console.log('\nrecoverable from the OPPORTUNITY:');
  console.log(`   ${String(have('oppId')).padStart(3)}/${rows.length}  opportunity id resolvable from the source key`);
  console.log(`   ${String(have('monetaryValue')).padStart(3)}/${rows.length}  monetaryValue  -> award_amount`);
  console.log(`   ${String(have('lastStageChangeAt')).padStart(3)}/${rows.length}  lastStageChangeAt  -> award_date candidate`);
  console.log('\nrecoverable from the CONTACT:');
  console.log(`   ${String(have('direct_grant_program')).padStart(3)}/${rows.length}  direct_grant_program  -> grant_program`);
  console.log(`   ${String(have('grant_reason_src')).padStart(3)}/${rows.length}  "please do into detail…"  -> grant_reason`);
  console.log(`   ${String(have('total_grant_amount')).padStart(3)}/${rows.length}  score_total_grant_amount (already key-matches)`);

  const prog:Record<string,number>={};
  for(const r of rows){const k=String(r.direct_grant_program??'(empty)');prog[k]=(prog[k]??0)+1;}
  console.log('\ndirect_grant_program values across the grants:');
  for(const [k,v] of Object.entries(prog).sort((a,b)=>b[1]-a[1])) console.log(`   ${String(v).padStart(3)}  ${k}`);

  const stages:Record<string,number>={};
  for(const r of rows){const k=`${r.oppStatus??'?'} / ${r.oppStage??'?'}`;stages[k]=(stages[k]??0)+1;}
  console.log('\nopportunity status / stage:');
  for(const [k,v] of Object.entries(stages).sort((a,b)=>b[1]-a[1])) console.log(`   ${String(v).padStart(3)}  ${k}`);

  const { isAiFailureText } = await import('../lib/activities/sources/sheetImport');
  const apologies=rows.filter((r)=>isAiFailureText(r.grant_reason_src)).length;
  console.log(`\nreason texts that are the ChatGPT apology (must not be imported): ${apologies}`);

  mkdirSync(join(process.cwd(),'reports'),{recursive:true});
  writeFileSync(join(process.cwd(),'reports/grant-fields-census.json'),
    JSON.stringify({generatedAt:new Date().toISOString(),grants:grants.length,rows},null,1));
  console.log('\nwrote reports/grant-fields-census.json');
}
main().catch(e=>{console.error(e);process.exit(1);});
