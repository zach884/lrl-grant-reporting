// READ-ONLY probe. The brief's email-only rule leaves 51 of 227 rows unresolved, and some of those
// companies plainly exist in GHL (Blue Entity, Mport Media Group). Same shape as the sheet import,
// where the workbook's email and GHL's email were simply different addresses for the same business.
//
// Question this answers: how many of the 51 would a GUARDED company-name resolution recover — the
// `namesLookAlike` guard the sheet import already uses, which took its unresolved count 38 -> 5?
// Nothing is written; this only decides whether the cascade is worth building.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
import { enumerateAllContacts } from '../lib/ghl/contacts';
import { normalizeCompanyName, namesLookAlike } from '../lib/sync/identityGuard';
function env(){const t=readFileSync(join(process.cwd(),'.env.local'),'utf8');
 for(const l of t.split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');}}
async function main(){
  env(); process.env.GHL_TARGET='live';
  const c=ghl();
  const biz:any[]=[]; let skip=0;
  for(;;){const d:any=await c.request({path:'/businesses/',params:{limit:100,skip}});
    const b=d.businesses??[]; if(!b.length)break; biz.push(...b); if(b.length<100)break; skip+=100;}
  const contacts=await enumerateAllContacts(c);
  const emails=new Set((contacts as any[]).filter(x=>x.email).map(x=>String(x.email).trim().toLowerCase()));
  const contactsFor=new Map<string,any[]>();
  for(const ct of contacts as any[]) if(ct.businessId){const a=contactsFor.get(ct.businessId)??[];a.push(ct);contactsFor.set(ct.businessId,a);}

  const review=JSON.parse(readFileSync(join(process.cwd(),'reports/gateway-metrics-review.json'),'utf8')).review;
  const unresolved=review.filter((r:any)=>r.why);
  const byNorm=new Map<string,any[]>();
  for(const b of biz){const k=normalizeCompanyName(b.name); const a=byNorm.get(k)??[];a.push(b);byNorm.set(k,a);}

  let exact=0, alike=0, ambiguous=0, none=0;
  const lines:string[]=[];
  for(const r of unresolved){
    const want=normalizeCompanyName(r.company);
    if(!want){none++; continue;}
    let hits=byNorm.get(want)??[];
    let how='exact';
    if(!hits.length){
      hits=biz.filter((b:any)=>namesLookAlike(want, normalizeCompanyName(b.name)));
      how='alike';
    }
    if(hits.length===1){
      const b=hits[0];
      const n=(contactsFor.get(b.id)??[]).length;
      if(how==='exact') exact++; else alike++;
      lines.push(`  ${how.padEnd(5)} ${String(r.company).slice(0,30).padEnd(30)} -> ${String(b.name).slice(0,30).padEnd(30)} (${n} contact${n===1?'':'s'})`);
    } else if(hits.length>1){ ambiguous++; lines.push(`  AMBIG ${String(r.company).slice(0,30).padEnd(30)} -> ${hits.map((h:any)=>h.name).slice(0,3).join(' | ')}`); }
    else none++;
  }
  console.log(`unresolved rows examined: ${unresolved.length}   (GHL holds ${emails.size} distinct contact emails)`);
  console.log(`\n  exact normalized name match : ${exact}`);
  console.log(`  namesLookAlike match        : ${alike}`);
  console.log(`  ambiguous (>1 company)      : ${ambiguous}   <-- must stay in review`);
  console.log(`  no company in GHL at all    : ${none}   <-- genuinely absent, nothing to attach to`);
  console.log(`\nrecoverable with the guard: ${exact+alike} of ${unresolved.length}\n`);
  for(const l of lines.slice(0,40)) console.log(l);
}
main().catch(e=>{console.error(e);process.exit(1);});
