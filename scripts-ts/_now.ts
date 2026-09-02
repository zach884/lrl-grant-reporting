import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
function env(){ const t=readFileSync(join(process.cwd(),'.env.local'),'utf8');
  for(const l of t.split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');}}
async function main(){ env(); process.env.GHL_TARGET='live';
  const c=ghl(); const acts:any[]=[];
  for(let page=1;page<=40;page++){
    const d:any=await c.request({method:'POST',path:'/objects/custom_objects.activities/records/search',autoLocation:false,
      body:{locationId:c.locationId,query:'',page,pageLimit:100,searchAfter:[],sort:[{field:'updatedAt',direction:'desc'}]}});
    const r=d.records??d.items??[]; acts.push(...r); if(r.length<100)break;
  }
  const by:Record<string,number>={};
  for(const a of acts) by[String(a.properties?.activity_type)]=(by[String(a.properties?.activity_type)]??0)+1;
  console.log('activities:',acts.length,JSON.stringify(by));
  console.log('sheet-sourced:',acts.filter(a=>/^(tc-cumulative|sbsh-companies):/.test(String(a.properties?.source_record_id??''))).length);
  // did the two companies get created?
  const biz:any[]=[]; let skip=0;
  for(;;){ const d:any=await c.request({path:'/businesses/',params:{limit:100,skip}}); const b=d.businesses??[]; if(!b.length)break; biz.push(...b); if(b.length<100)break; skip+=100; }
  console.log('companies:',biz.length);
  for(const n of ['frame studio','jessie']) {
    const hit=biz.filter(b=>String(b.name??'').toLowerCase().includes(n));
    console.log(`  "${n}" ->`, hit.length? hit.map(h=>`${JSON.stringify(h.name)} (${h.id})`).join(', ') : 'NOT FOUND');
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
