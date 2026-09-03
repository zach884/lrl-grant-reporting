// READ-ONLY. Confirm the live activities catalog against the Gateway brief's column map.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
import { getCatalog } from '../lib/ghl/catalogCache';
function env(){const t=readFileSync(join(process.cwd(),'.env.local'),'utf8');
 for(const l of t.split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');}}
async function main(){
  env(); process.env.GHL_TARGET='live';
  const c=ghl();
  const cat:any = await getCatalog('custom_objects.activities',{client:c});
  const keys = Object.keys(cat.byKey).map((k)=>k.replace('custom_objects.activities.',''));
  const uniq = Array.from(new Set(keys)).sort();
  console.log(`live activities fields: ${uniq.length}`);
  const hits = uniq.filter((k)=>/bank|loan|debt|invest|fund|sales/i.test(k));
  console.log('\nfunding-ish keys on live:');
  for (const k of hits) console.log(`   ${k}   [${cat.byKey[`custom_objects.activities.${k}`]?.dataType}]`);
}
main().catch(e=>{console.error(e);process.exit(1);});
