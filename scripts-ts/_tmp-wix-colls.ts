import { readFileSync } from 'node:fs';
import { join } from 'node:path';
try {
  for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
(async () => {
  const { wix } = await import('../lib/wix/client');
  const c = wix();
  const data: any = await c.request({ method: 'GET', path: '/wix-data/v2/collections', params: { 'paging.limit': 200 } });
  const cols: any[] = data.collections ?? data.dataCollections ?? [];
  for (const x of cols) console.log((x.collectionType ?? '?').padEnd(10), (x.id ?? x._id ?? '?').padEnd(28), '|', x.displayName);
  console.log('TOTAL', cols.length);
})().catch((e) => { console.error('ERR', e?.message ?? e); process.exit(1); });
