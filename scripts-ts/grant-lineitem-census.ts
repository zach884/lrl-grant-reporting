// READ-ONLY. Two questions before building anything:
//   1. do the 64 grant activities actually CARRY line items? (an enricher needs input)
//   2. what does each opportunity's lastStatusChangeAt say? (Zach: activity_date should be the close
//      date / status change date)
// Also re-checks the key-match between contact and activity line-item fields, since that is how the
// bank-loan drop happened and `contact.expense_category_item3` is missing an underscore.
import { readFileSync, writeFileSync } from 'node:fs';
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
const STAGE:Record<string,string>={
 '0dfd181d-1270-4fb2-81e9-99606b8fa216':'Execute Agreement',
 '29569048-1326-489b-b658-4b7bebeba54b':'Receive Receipts',
 '37c0eae6-c3cd-4b2c-b5bb-7cf56248da0b':'Closed Won',
 'c08c538e-77e3-4408-8575-4c288569697d':'Closed Lost'};
const blank=(v:unknown)=>v==null||v===''||(Array.isArray(v)&&v.length===0);
async function main(){
  env(); process.env.GHL_TARGET='live';
  const c=ghl();
  const { getCatalog } = await import('../lib/ghl/catalogCache');
  const [act,con]=await Promise.all([getCatalog('custom_objects.activities',{client:c}),getCatalog('contact',{client:c})]);
  const aKeys=new Set(Object.keys((act as any).byKey).map(k=>k.replace('custom_objects.activities.','')));
  const cKeys=new Set(Object.keys((con as any).byKey).map(k=>k.replace('contact.','')));
  console.log('LINE-ITEM KEY MATCH (contact -> activity), the bank-loan failure mode:');
  const li=Array.from(cKeys).filter(k=>/^expense_(amount|category|description|vendor)/.test(k)).sort();
  const broken=li.filter(k=>!aKeys.has(k));
  console.log(`   ${li.length} line-item fields on the contact, ${li.length-broken.length} key-match the activity`);
  for(const b of broken) console.log(`   🔴 contact.${b}  has NO activity twin -> dropped on every submission`);
  const orphanA=Array.from(aKeys).filter(k=>/^expense_(amount|category|description|vendor)/.test(k)&&!cKeys.has(k)).sort();
  for(const o of orphanA) console.log(`   ⚠️  activities.${o}  has no contact twin -> can never be filled by the form`);

  const acts:any[]=[];
  for(let page=1;page<=40;page+=1){
    const d:any=await c.request({method:'POST',path:'/objects/custom_objects.activities/records/search',autoLocation:false,
      body:{locationId:c.locationId,query:'',page,pageLimit:100,searchAfter:[],sort:[{field:'updatedAt',direction:'desc'}]}});
    const r=d.records??d.items??[]; acts.push(...r); if(r.length<100)break;
  }
  const grants=acts.filter((a:any)=>String(a.properties?.activity_type)==='grant');
  console.log(`\nLINE ITEMS ON THE ${grants.length} GRANT ACTIVITIES:`);
  const withAny=grants.filter((a:any)=>Array.from({length:10},(_,i)=>i+1).some(i=>!blank(a.properties?.[`expense_amount_item_${i}`])||!blank(a.properties?.[`expense_description_item_${i}`])));
  console.log(`   records carrying at least one line item: ${withAny.length}/${grants.length}`);
  for(const kind of ['amount','description','category','vendor']){
    const n=grants.filter((a:any)=>Array.from({length:10},(_,i)=>i+1).some(i=>!blank(a.properties?.[`expense_${kind}_item_${i}`]))).length;
    console.log(`     ${String(n).padStart(3)}/${grants.length}  has at least one expense_${kind}_item_*`);
  }
  const counts:Record<number,number>={};
  for(const a of grants){
    const n=Array.from({length:10},(_,i)=>i+1).filter(i=>!blank(a.properties?.[`expense_amount_item_${i}`])).length;
    counts[n]=(counts[n]??0)+1;
  }
  console.log('   line items per grant record:');
  for(const [n,v] of Object.entries(counts).sort((a,b)=>Number(a[0])-Number(b[0]))) console.log(`     ${String(v).padStart(3)} record(s) with ${n} item(s)`);
  const sample=withAny.slice(0,3);
  for(const a of sample){
    console.log(`\n   e.g. ${String(a.properties?.activity_name).slice(0,44)}`);
    for(let i=1;i<=10;i+=1){
      const amt=a.properties?.[`expense_amount_item_${i}`], desc=a.properties?.[`expense_description_item_${i}`];
      const cat=a.properties?.[`expense_category_item_${i}`], ven=a.properties?.[`expense_vendor_item_${i}`];
      if(blank(amt)&&blank(desc)) continue;
      console.log(`        ${i}. $${amt ?? '?'}  [${cat ?? '-'}]  ${String(desc??'').slice(0,42)}  vendor=${String(ven??'-').slice(0,18)}`);
    }
  }

  // Close date / status change date, per Zach.
  const census=JSON.parse(readFileSync(join(process.cwd(),'reports/grant-fields-census.json'),'utf8'));
  const out:any[]=[];
  for(const r of census.rows){
    let opp:any=null;
    try{ const d:any=await c.request({path:`/opportunities/${r.oppId}`}); opp=d.opportunity??d; }catch{}
    out.push({...r, lastStatusChangeAt:opp?.lastStatusChangeAt??null, oppCreatedAt:opp?.createdAt??null, oppName:opp?.name??r.name});
    await new Promise((x)=>setTimeout(x,130));
  }
  const sameSS=out.filter((r)=>String(r.lastStatusChangeAt??'').slice(0,10)===String(r.lastStageChangeAt??'').slice(0,10)).length;
  console.log(`\nCLOSE DATE (lastStatusChangeAt) vs lastStageChangeAt:`);
  console.log(`   populated: ${out.filter((r)=>!blank(r.lastStatusChangeAt)).length}/${out.length}`);
  console.log(`   same day as lastStageChangeAt: ${sameSS}/${out.length}`);
  const byStage:Record<string,{n:number;same:number}>={};
  for(const r of out){
    const s=STAGE[r.oppStage]??r.oppStage; byStage[s]=byStage[s]??{n:0,same:0}; byStage[s].n+=1;
    if(String(r.lastStatusChangeAt??'').slice(0,10)===String(r.lastStageChangeAt??'').slice(0,10)) byStage[s].same+=1;
  }
  for(const [s,v] of Object.entries(byStage)) console.log(`     ${s.padEnd(18)} ${String(v.n).padStart(3)}  same day: ${v.same}`);
  writeFileSync(join(process.cwd(),'reports/grant-lineitem-census.json'),JSON.stringify({generatedAt:new Date().toISOString(),rows:out},null,1));
  console.log('\nwrote reports/grant-lineitem-census.json');
}
main().catch(e=>{console.error(e);process.exit(1);});
