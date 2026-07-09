import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBusinessFieldCatalog, getContactFieldCatalog } from '../lib/ghl/customFields';
import { resolveMappings, collectIssues, FileMappingStore } from '../lib/mapping';
function loadEnv(){const t=readFileSync(join(process.cwd(),'.env.local'),'utf8');for(const l of t.split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');}}
async function main(){
  loadEnv(); process.env.GHL_TARGET='live';
  const [c,b]=await Promise.all([getContactFieldCatalog(),getBusinessFieldCatalog()]);
  const set=await new FileMappingStore().load();
  const enabled=set.mappings.filter(m=>m.enabled!==false);
  const res=resolveMappings(enabled,c,b);
  const issues=collectIssues(res);
  const errs=issues.filter(i=>i.level==='error');
  const warns=issues.filter(i=>i.level==='warning');
  console.log(`rows total=${set.mappings.length} enabled=${enabled.length} disabled=${set.mappings.length-enabled.length}`);
  console.log(`ERRORS=${errs.length} WARNINGS=${warns.length}`);
  for(const e of errs) console.log('  ERROR',e.businessKey,'<-',e.contactKey,':',e.message);
  for(const w of warns) console.log('  warn',w.businessKey,'<-',w.contactKey,':',w.message);
}
main().catch(e=>{console.error(e);process.exit(1);});
