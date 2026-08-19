// pages/api/activities/metrics-history.ts — a company's metrics, period by period.
// `?format=csv` returns it as a file, which is the form a funder spot check tends to want.

import type { NextApiRequest, NextApiResponse } from 'next';
import { metricsHistoryForCompany } from '@/lib/activities/metricsHistory';

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const companyId = String(req.query.companyId ?? '').trim();
  if (!companyId) return res.status(400).json({ error: 'companyId required' });

  try {
    const history = await metricsHistoryForCompany(companyId);
    if (req.query.format === 'csv') {
      const header = ['Metric', ...history.periods.map((p) => p.label)];
      const lines = [header.map(csvCell).join(',')];
      for (const r of history.rows) {
        lines.push([r.label, ...history.periods.map((p) => r.byPeriod[p.end] ?? '')].map(csvCell).join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="metrics-${companyId}.csv"`);
      return res.status(200).send(lines.join('\n'));
    }
    res.status(200).json(history);
  } catch (error: any) {
    console.error('Metrics history error:', error);
    res.status(500).json({ error: error.message ?? 'Failed to load metrics history' });
  }
}
