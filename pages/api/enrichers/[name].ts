// pages/api/enrichers/[name].ts — get (GET) / save (PUT) one enricher's gate config.
// Mutations are admin-guarded, like the mapping routes. sourceObject via ?sourceObject= (default contact).

import type { NextApiRequest, NextApiResponse } from 'next';
import { hasDatabase } from '@/lib/db';
import { isAdmin } from '@/lib/auth/admin';
import { getEnricherConfigStore, resolveEnricherConfig, sanitizeEnricherConfigInput } from '@/lib/enrichment/configStore';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const name = typeof req.query.name === 'string' ? req.query.name : '';
  if (!name) return res.status(400).json({ error: 'enricher name required' });
  const sourceObject = (typeof req.query.sourceObject === 'string' && req.query.sourceObject) || 'contact';

  if (req.method === 'GET') {
    // Always resolvable (falls back to the code default), even with no DB or no row.
    const config = await resolveEnricherConfig(name, sourceObject);
    return res.status(200).json({ config });
  }

  if (req.method === 'PUT') {
    if (!hasDatabase) return res.status(503).json({ error: 'database not configured' });
    if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
    try {
      const input = sanitizeEnricherConfigInput(req.body, name, sourceObject);
      const config = await getEnricherConfigStore().upsert(input);
      return res.status(200).json({ config });
    } catch (e: any) {
      return res.status(400).json({ error: e?.message ?? 'invalid config' });
    }
  }

  return res.status(405).json({ error: 'GET or PUT' });
}
