import { readFileSync } from 'node:fs';
import { join } from 'node:path';
for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
process.env.GHL_TARGET ||= 'live';
(async () => {
  const { ghl } = await import('../lib/ghl/client');
  const c = ghl();
  // Opportunities in the LOCAL + SAMA pipelines, to see the payload and the stage distribution.
  for (const [pid, name] of [['Ewioq7ycVmNpJ9oCM3JC', 'LOCAL Fellows Bootcamp'], ['nRK4xQsQ9V4jmXbmz5YO', 'S&MA Cohort']] as const) {
    const d: any = await c.request({ path: '/opportunities/search', params: { location_id: c.locationId, pipeline_id: pid, limit: "100" }, autoLocation: false });
    const opps: any[] = d.opportunities ?? [];
    const byStage: Record<string, number> = {};
    for (const o of opps) byStage[o.pipelineStageId ?? '?'] = (byStage[o.pipelineStageId ?? '?'] ?? 0) + 1;
    console.log(`\n${name}: ${opps.length} opportunities`);
    for (const [sid, n] of Object.entries(byStage)) console.log(`   ${sid}  ${n}`);
    if (opps[0]) {
      const o = opps[0];
      console.log('   sample keys:', Object.keys(o).join(', '));
      console.log('   sample:', JSON.stringify({ id: o.id, name: o.name, pipelineId: o.pipelineId, pipelineStageId: o.pipelineStageId, contactId: o.contactId ?? o.contact?.id, status: o.status, createdAt: o.createdAt, updatedAt: o.updatedAt, lastStageChangeAt: o.lastStageChangeAt }));
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
