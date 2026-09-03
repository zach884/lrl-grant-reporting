// READ-ONLY. Does the new field actually reach a metrics activity from a real form submission?
// The field set is derived from the LIVE catalog by FOLDER NAME, so creating the field beside its
// siblings should be all that is required — but "should" is not evidence.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
import { getCatalog } from '../lib/ghl/catalogCache';
import { activityFieldSet, bareKey } from '../lib/activities/schema';
function env(){const t=readFileSync(join(process.cwd(),'.env.local'),'utf8');
 for(const l of t.split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');}}
const KEY='bank_loans_received_in_the_last_6_months';
async function main(){
  env(); process.env.GHL_TARGET='live';
  const c=ghl();
  const [act, con] = await Promise.all([getCatalog('custom_objects.activities',{client:c}), getCatalog('contact',{client:c})]);
  const set = activityFieldSet(act as any, 'metrics');
  const keys = new Set([...set.core, ...set.typeFields].map(bareKey));
  console.log(`metrics field set: ${set.typeFields.length} type fields + ${set.core.length} core`);
  console.log(`  activity has ${KEY}:            ${Boolean((act as any).byKey[`custom_objects.activities.${KEY}`])}`);
  console.log(`  it is IN the metrics field set:  ${keys.has(KEY)}   <-- this is what makes the form copy it`);
  console.log(`  contact has the twin:            ${Boolean((con as any).byKey[`contact.${KEY}`])}`);
  const sibs = ['venture_capital_funding_received_in_the_last_6_months','owner_investment_in_the_last_6_months'];
  for (const s of sibs) console.log(`  sibling ${s} in set: ${keys.has(s)}`);
  const missing = Array.from(keys).filter((k)=>!(con as any).byKey[`contact.${k}`]);
  console.log(`\n${missing.length} metrics field(s) with NO contact twin (a real submission can never fill these):`);
  for (const m of missing) console.log(`   ${m}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
