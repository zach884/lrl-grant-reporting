// scripts-ts/identity-audit.ts — READ-ONLY. Runs checkCompanyIdentity over every linked contact and
// reports how many would be BLOCKED, so the guard's threshold is chosen from evidence rather than
// hope. Also the triage list for re-pointing associations.
//   npx vite-node scripts-ts/identity-audit.ts [--list] [--limit N]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
import { enumerateAllContacts } from '../lib/ghl/contacts';
import { checkCompanyIdentity, type IdentityVerdict } from '../lib/sync/identityGuard';
function env(){ const t=readFileSync(join(process.cwd(),'.env.local'),'utf8');
  for(const l of t.split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');}}
async function main(){
  env(); process.env.GHL_TARGET='live';
  const c=ghl();
  const biz:any[]=[]; let skip=0;
  for(;;){ const d:any=await c.request({path:'/businesses/',params:{limit:100,skip}});
    const b=d.businesses??[]; if(!b.length)break; biz.push(...b); if(b.length<100)break; skip+=100; }
  const byId=new Map(biz.map(b=>[b.id,b]));
  const contacts=await enumerateAllContacts(c);
  const linked=contacts.filter((x:any)=>x.businessId);
  const counts:Record<IdentityVerdict,number>={match:0,renamed:0,mismatch:0,'no-evidence':0};
  const blocked:any[]=[]; let orphan=0;
  for(const ct of linked as any[]){
    const b=byId.get(ct.businessId);
    if(!b){ orphan++; continue; }
    const v=checkCompanyIdentity({
      contactCompanyName: ct.companyName, contactWebsite: ct.website,
      companyName: b.name, companyWebsite: b.website });
    counts[v.verdict]++;
    if(!v.ok) blocked.push({contact:`${ct.firstName??''} ${ct.lastName??''}`.trim(), contactId:ct.id,
      companyId:b.id, claims:ct.companyName, linkedTo:b.name, reason:v.reason});
  }
  const n=linked.length;
  console.log(`linked contacts: ${n}   (businessId pointing at a missing company: ${orphan})`);
  console.log('\nverdicts:');
  for(const [k,v] of Object.entries(counts))
    console.log(`   ${k.padEnd(12)} ${String(v).padStart(5)}  ${(v/n*100).toFixed(1)}%${k==='mismatch'?'   <-- WOULD BE BLOCKED':''}`);
  const byReason:Record<string,number>={};
  for(const b of blocked){ const k=b.reason.startsWith('different domains')?'different domains':'different names, no shared domain';
    byReason[k]=(byReason[k]??0)+1; }
  console.log('\nblocked, by reason:'); for(const [k,v] of Object.entries(byReason)) console.log(`   ${String(v).padStart(5)}  ${k}`);
  if(process.argv.includes('--list')){
    const lim=Number(process.argv[process.argv.indexOf('--limit')+1])||25;
    console.log(`\nfirst ${lim} blocked:`);
    for(const b of blocked.slice(0,lim))
      console.log(`   ${b.contact} — claims ${JSON.stringify(b.claims)} but linked to ${JSON.stringify(b.linkedTo)}\n        ${b.reason}`);
  }
  mkdirSync(join(process.cwd(),'reports'),{recursive:true});
  writeFileSync(join(process.cwd(),'reports/identity-audit.json'),
    JSON.stringify({generatedAt:new Date().toISOString(),linked:n,orphan,counts,blocked},null,2));
  console.log('\nwrote reports/identity-audit.json');
}
main().catch(e=>{console.error(e);process.exit(1);});
