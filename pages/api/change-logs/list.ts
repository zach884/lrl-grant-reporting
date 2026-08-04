// pages/api/change-logs/list.ts — read the change log as JSON, or export it as CSV (?format=csv).
// Read-only (relies on Vercel deployment protection, like the other read endpoints). Honors the same
// filters as the Change Logs page so "export" matches what you're looking at.

import type { NextApiRequest, NextApiResponse } from 'next';
import { queryChangeLog, type ChangeLogFilter } from '@/lib/audit/query';
import type { ChangeLogFieldChange } from '@/lib/audit/types';

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function filtersFrom(req: NextApiRequest): ChangeLogFilter {
  const q = req.query;
  return {
    q: str(q.q), actorKind: str(q.actorKind), actorName: str(q.actorName), app: str(q.app),
    applied: str(q.applied), recordId: str(q.recordId), runId: str(q.runId), since: str(q.since),
    limit: q.limit ? Number(q.limit) : undefined, offset: q.offset ? Number(q.offset) : undefined,
  };
}

const summarizeChanges = (changes: ChangeLogFieldChange[] | null) =>
  (changes ?? []).map((c) => `${c.field}: ${c.from === undefined ? '' : JSON.stringify(c.from) + '→'}${JSON.stringify(c.to)}`).join('; ');

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const format = str(req.query.format);
    if (format === 'csv') {
      const { rows } = await queryChangeLog({ ...filtersFrom(req), limit: 500 });
      const header = ['ts', 'app', 'object_type', 'record_id', 'record_label', 'actor_kind', 'actor_name', 'action', 'changes', 'method', 'confidence', 'rationale', 'trigger', 'run_id', 'applied'];
      const lines = [header.join(',')];
      for (const r of rows) {
        lines.push([
          r.ts instanceof Date ? r.ts.toISOString() : String(r.ts), r.app, r.objectType, r.recordId, r.recordLabel,
          r.actorKind, r.actorName, r.action, summarizeChanges(r.changes), r.method, r.confidence, r.rationale,
          r.trigger, r.runId, r.applied,
        ].map(csvCell).join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="change-log-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.status(200).send(lines.join('\n') + '\n');
    }
    const { rows, hasMore } = await queryChangeLog(filtersFrom(req));
    return res.status(200).json({ rows, hasMore });
  } catch (e: any) {
    console.error('change-logs/list error:', e);
    return res.status(500).json({ error: e?.message ?? 'failed to load change logs' });
  }
}
