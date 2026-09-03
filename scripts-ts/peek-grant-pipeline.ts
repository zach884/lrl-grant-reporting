// READ-ONLY. Which stage is "Agreement Executed", and what does an opportunity actually expose?
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
function env(){const t=readFileSync(join(process.cwd(),'.env.local'),'utf8');
 for(const l of t.split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');}}
async function main(){
  env(); process.env.GHL_TARGET='live';
  const c=ghl();
  const d:any=await c.request({path:'/opportunities/pipelines'});
  for(const p of (d.pipelines??[])){
    console.log(`\nPIPELINE ${p.name}   id=${p.id}`);
    for(const s of (p.stages??[])) console.log(`   ${s.id}  ${s.name}`);
  }
  // What fields does one grant opportunity actually carry?
  const census=JSON.parse(readFileSync(join(process.cwd(),'reports/grant-fields-census.json'),'utf8'));
  const one=census.rows.find((r:any)=>r.oppId);
  if(one){
    const o:any=await c.request({path:`/opportunities/${one.oppId}`});
    const opp=o.opportunity??o;
    console.log(`\nONE OPPORTUNITY (${one.oppId}) — keys it exposes:`);
    for(const [k,v] of Object.entries(opp)){
      if(k==='customFields'||k==='contact') continue;
      console.log(`   ${k.padEnd(24)} ${JSON.stringify(v)?.slice(0,70)}`);
    }
    console.log('\n   ...any stage HISTORY exposed? ->', Object.keys(opp).filter((k)=>/hist|stage|audit|log/i.test(k)));
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
