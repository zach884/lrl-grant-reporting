// scripts-ts/grant-activity-date-repair.ts — put the real close date on the grant activities.
//
// THE BUG. `activity_date` is 100% populated on the 64 grant activities but reads **2026-08-20 on
// 52 of them** — the day the first grant backfill ran — while the opportunity's own timestamps hold
// real dates spread over 47 distinct days (2025-11-25 → 2026-09-02). The
// `onlyIfAbsent: ['activity_date']` guard was added to stop the nightly sweep rewriting these, but it
// went in AFTER that backfill had already written the run date, so it froze the wrong value rather
// than preventing it. The guard is working exactly as designed and protecting an artifact.
//
// WHY IT MATTERS MORE THAN AN EMPTY FIELD. `activity_date` is what assigns an activity to a reporting
// period. A grant awarded 2026-01-31 but dated 2026-08-20 is counted in the wrong half-year on every
// period-filtered report — and it looks entirely plausible, because the field is full.
//
// THE RULE. Zach, 2026-09-03: *"If we can update Activity_date then we should use close date or status
// change date for the grant activities."* So: `opportunity.lastStatusChangeAt` — the moment the
// opportunity's status became won or lost, which IS the close date. Measured 64/64 populated.
// (`lastStageChangeAt` is deliberately NOT used: it is the last STAGE move, which for the 36 records
// at Closed Won is when receipts were accepted, and it disagrees with the close date on 34 of 64.)
//
//   npx vite-node scripts-ts/grant-activity-date-repair.ts            # dry run
//   npx vite-node scripts-ts/grant-activity-date-repair.ts --apply
//
// This is deliberately its OWN script and not folded into a field backfill: it rewrites a guarded
// field on live records, so it gets its own dry run and its own approval.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';

const APPLY = process.argv.includes('--apply');
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

async function main(){
  env(); process.env.GHL_TARGET='live';
  const c=ghl();
  console.log(APPLY?'MODE: APPLY\n':'MODE: DRY RUN (pass --apply to write)\n');

  const { getCatalog } = await import('../lib/ghl/catalogCache');
  const { writeRecordFields } = await import('../lib/ghl/writeRecord');
  const { logChange } = await import('../lib/audit/log');
  const catalog:any = await getCatalog('custom_objects.activities',{client:c});

  const acts:any[]=[];
  for(let page=1;page<=40;page+=1){
    const d:any=await c.request({method:'POST',path:'/objects/custom_objects.activities/records/search',autoLocation:false,
      body:{locationId:c.locationId,query:'',page,pageLimit:100,searchAfter:[],sort:[{field:'updatedAt',direction:'desc'}]}});
    const r=d.records??d.items??[]; acts.push(...r); if(r.length<100)break;
  }
  const grants=acts.filter((a:any)=>String(a.properties?.activity_type)==='grant');
  console.log(`grant activities: ${grants.length}`);

  const plan:any[]=[]; const tally:Record<string,number>={};
  const bump=(k:string)=>{tally[k]=(tally[k]??0)+1;};

  for(const a of grants){
    const key=String(a.properties?.source_record_id??'');
    const oppId=key.endsWith(':grant')?key.slice(0,-':grant'.length):null;
    if(!oppId){ bump('skip:no-opportunity-in-source-key'); continue; }
    let opp:any=null;
    try{ const d:any=await c.request({path:`/opportunities/${oppId}`}); opp=d.opportunity??d; }catch{ bump('skip:opportunity-gone'); continue; }
    const close=String(opp?.lastStatusChangeAt??'').slice(0,10);
    if(!close){ bump('skip:no-close-date'); continue; }
    const current=String(a.properties?.activity_date??'').slice(0,10);
    if(current===close){ bump('noop:already-the-close-date'); continue; }
    plan.push({
      activityId:a.id, name:String(a.properties?.activity_name??'').slice(0,44),
      oppId, stage:STAGE[opp?.pipelineStageId]??opp?.pipelineStageId, status:opp?.status,
      from:current, to:close,
      alsoStageChange:String(opp?.lastStageChangeAt??'').slice(0,10),
    });
    bump(current==='2026-08-20'?'change:from-the-backfill-run-date':'change:from-another-date');
    await new Promise((r)=>setTimeout(r,130));
  }

  console.log('\nOUTCOMES:',JSON.stringify(tally,null,1));
  console.log(`\n${plan.length} record(s) would change activity_date:`);
  for(const p of plan.slice(0,20)) console.log(`   ${p.from} -> ${p.to}   ${String(p.stage).padEnd(17)} ${p.name}`);
  if(plan.length>20) console.log(`   …and ${plan.length-20} more`);

  // How far off were they? A period-attribution error only matters if it crosses a boundary.
  const months=new Set(plan.map((p)=>`${p.from.slice(0,7)}->${p.to.slice(0,7)}`));
  console.log(`\ndistinct month moves: ${months.size}`);
  const halves=(d:string)=>{const [y,m]=d.split('-').map(Number); return `${m<=2?y-1:m<=8?y:y}H${m<=2?2:m<=8?1:2}`;};
  const crossing=plan.filter((p)=>halves(p.from)!==halves(p.to)).length;
  console.log(`records whose REPORTING PERIOD changes as a result: ${crossing}/${plan.length}  <-- the reason this matters`);

  writeFileSync(join(process.cwd(),'reports/grant-activity-date-repair.json'),
    JSON.stringify({generatedAt:new Date().toISOString(),mode:APPLY?'apply':'dry-run',count:plan.length,plan},null,1));
  console.log('\n→ reports/grant-activity-date-repair.json');
  if(!APPLY){ console.log('nothing written.'); return; }

  let wrote=0;
  for(const p of plan){
    const res=await writeRecordFields('custom_objects.activities',p.activityId,{activity_date:p.to},catalog,c);
    if(res.written.length){
      wrote+=1;
      await logChange({
        objectType:'custom_objects.activities', recordId:p.activityId, recordLabel:p.name,
        actorKind:'sync', actorName:'grant-activity-date-repair',
        action:'update',
        changes:[{field:'custom_objects.activities.activity_date',from:p.from,to:p.to,source:'Opportunity Stage'}],
        method:'opportunity.lastStatusChangeAt (close date)',
        rationale:'activity_date held the 2026-08-20 backfill run date, not the grant close date',
        applied:true,
      }).catch(()=>{});
    } else {
      console.log(`   NOT WRITTEN: ${p.activityId} (${JSON.stringify(res.skipped)})`);
    }
    await new Promise((r)=>setTimeout(r,320));
  }
  console.log(`\nwrote activity_date on ${wrote}/${plan.length} record(s)`);
}
main().catch(e=>{console.error(e);process.exit(1);});
