// READ-ONLY. Zach, 2026-09-04: "In the Client Stage Tracking object I am seeing lots of duplicates
// and then nobody has been scored since 8/27." This counts the duplicates and says how they arose.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
function env(){ try {
  const t=readFileSync(join(process.cwd(),'.env.local'),'utf8');
  for(const l of t.split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');}
} catch { /* CI */ } }
async function main(){
  env(); process.env.GHL_TARGET='live';
  const c=ghl();
  const { STAGE_OBJECT } = await import('../lib/stage/priorAssessment');
  const { getRelatedRecordIds } = await import('../lib/ghl/associations');
  const recs:any[]=[];
  for(let page=1;page<=60;page+=1){
    const d:any=await c.request({method:'POST',path:`/objects/${STAGE_OBJECT}/records/search`,autoLocation:false,
      body:{locationId:c.locationId,query:'',page,pageLimit:100,searchAfter:[],sort:[{field:'updatedAt',direction:'desc'}]}});
    const r=d.records??d.items??[]; recs.push(...r); if(r.length<100)break;
  }
  console.log(`${STAGE_OBJECT}: ${recs.length} record(s)\n`);
  if(recs.length){
    console.log('property keys on the newest record:');
    console.log('  ', Object.keys(recs[0].properties ?? {}).join(', '));
    console.log('\nnewest 3:');
    for(const r of recs.slice(0,3)) console.log('  ', JSON.stringify(r.properties).slice(0,260));
  }
  // Group by company via the association.
  const byCompany=new Map<string,any[]>();
  let orphan=0;
  for(const r of recs){
    const ids=await getRelatedRecordIds(r.id,'business',c).catch(()=>[] as string[]);
    if(!ids.length){ orphan++; continue; }
    for(const id of ids){ const a=byCompany.get(id)??[]; a.push(r); byCompany.set(id,a); }
    await new Promise((x)=>setTimeout(x,105));
  }
  const multi=Array.from(byCompany.entries()).filter(([,v])=>v.length>1);
  console.log(`\ncompanies with a stage record: ${byCompany.size}`);
  console.log(`records not associated to any company: ${orphan}`);
  console.log(`companies with MORE THAN ONE: ${multi.length}`);
  const hist:Record<number,number>={};
  for(const v of Array.from(byCompany.values())) hist[v.length]=(hist[v.length]??0)+1;
  console.log('records per company:');
  for(const [k,v] of Object.entries(hist).sort((a,b)=>Number(a[0])-Number(b[0]))) console.log(`   ${String(v).padStart(4)} company(ies) with ${k} record(s)`);
  console.log('\nworst offenders:');
  for(const [cid,v] of multi.sort((a,b)=>b[1].length-a[1].length).slice(0,8)){
    console.log(`   company ${cid}: ${v.length} records`);
    for(const r of v.slice(0,6)){
      const p=r.properties??{};
      console.log(`      ${String(r.id).slice(0,10)}  created=${String(r.createdAt??p.createdAt??'?').slice(0,10)}  ${JSON.stringify(p).slice(0,120)}`);
    }
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
