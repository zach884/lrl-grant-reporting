// READ-ONLY. Is a defensible award date recoverable for ANY of the 64?
// The stage the opportunity sits at NOW decides what lastStageChangeAt means:
//   Receive Receipts -> the moment it LEFT Execute Agreement (within days of the award)
//   Closed Won       -> the moment receipts were accepted, potentially weeks after the award
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
function env(){const t=readFileSync(join(process.cwd(),'.env.local'),'utf8');
 for(const l of t.split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');}}
const STAGE:Record<string,string>={
 '0dfd181d-1270-4fb2-81e9-99606b8fa216':'Execute Agreement',
 '29569048-1326-489b-b658-4b7bebeba54b':'Receive Receipts',
 '37c0eae6-c3cd-4b2c-b5bb-7cf56248da0b':'Closed Won',
 'c08c538e-77e3-4408-8575-4c288569697d':'Closed Lost'};
async function main(){
  env(); process.env.GHL_TARGET='live';
  const c=ghl();
  const acts:any[]=[];
  for(let page=1;page<=40;page+=1){
    const d:any=await c.request({method:'POST',path:'/objects/custom_objects.activities/records/search',autoLocation:false,
      body:{locationId:c.locationId,query:'',page,pageLimit:100,searchAfter:[],sort:[{field:'updatedAt',direction:'desc'}]}});
    const r=d.records??d.items??[]; acts.push(...r); if(r.length<100)break;
  }
  const byKey=new Map<string,any>();
  for(const a of acts) if(String(a.properties?.activity_type)==='grant') byKey.set(String(a.properties?.source_record_id??''),a);
  const census=JSON.parse(readFileSync(join(process.cwd(),'reports/grant-fields-census.json'),'utf8'));
  let same=0, differs=0;
  const perStage:Record<string,{n:number;same:number}>={};
  const examples:string[]=[];
  for(const r of census.rows){
    const a=byKey.get(r.key); if(!a) continue;
    const ad=String(a.properties?.activity_date??'').slice(0,10);
    const ls=String(r.lastStageChangeAt??'').slice(0,10);
    const st=STAGE[r.oppStage]??r.oppStage;
    perStage[st]=perStage[st]??{n:0,same:0};
    perStage[st].n+=1;
    if(ad===ls){same++;perStage[st].same+=1;} else {differs++; if(examples.length<8) examples.push(`   ${st.padEnd(18)} activity_date=${ad}  lastStageChangeAt=${ls}  ${String(r.name).slice(0,34)}`);}
  }
  console.log(`activity_date == lastStageChangeAt : ${same}`);
  console.log(`activity_date differs             : ${differs}\n`);
  console.log('by the stage the opportunity sits at now:');
  for(const [st,v] of Object.entries(perStage)) console.log(`   ${st.padEnd(18)} ${String(v.n).padStart(3)} records, ${v.same} with activity_date == lastStageChangeAt`);
  if(examples.length){ console.log('\nwhere they differ (activity_date preserved an EARLIER moment):'); for(const e of examples) console.log(e); }
}
main().catch(e=>{console.error(e);process.exit(1);});
