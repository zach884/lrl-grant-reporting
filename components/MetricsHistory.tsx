// components/MetricsHistory.tsx — a company's reported metrics, one column per reporting period.
//
// The spot-check view: "the MEDC went two periods back" means reading the column for that period,
// not the client's current numbers. Only metrics that have ever been answered are shown — the survey
// asks 35 questions and a client answers a handful.

import { useEffect, useState } from 'react';

interface Period { end: string; label: string; activityId: string }
interface Row { key: string; label: string; byPeriod: Record<string, string> }

export default function MetricsHistory({ companyId }: { companyId: string }) {
  const [data, setData] = useState<{ periods: Period[]; rows: Row[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!companyId) { setData(null); return; }
    (async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch(`/api/activities/metrics-history?companyId=${encodeURIComponent(companyId)}`);
        const d = await res.json();
        if (!res.ok) throw new Error(d.error ?? 'Failed to load');
        setData(d);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [companyId]);

  if (!companyId) return null;
  if (loading) return <div style={{ fontSize: 13, color: 'var(--gray-500)' }}>Loading metrics…</div>;
  if (error) return <div style={{ fontSize: 13, color: 'var(--red-600, #b3261e)' }}>{error}</div>;
  if (!data?.periods.length) {
    return (
      <div style={{ fontSize: 13, color: 'var(--gray-500)' }}>
        No reported metrics yet. Each Client Reporting submission becomes its own snapshot, so periods
        will accumulate here from the next collection onward.
      </div>
    );
  }

  const cell: React.CSSProperties = { padding: '7px 12px', fontSize: 13, borderBottom: '1px solid var(--border)', textAlign: 'right', whiteSpace: 'nowrap' };
  const head: React.CSSProperties = { ...cell, fontWeight: 700, fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--gray-500)', borderBottom: '1px solid var(--border-strong)' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--gray-500)' }}>
          {data.periods.length} reporting period{data.periods.length === 1 ? '' : 's'} · {data.rows.length} metric{data.rows.length === 1 ? '' : 's'} answered
        </span>
        <a
          href={`/api/activities/metrics-history?companyId=${encodeURIComponent(companyId)}&format=csv`}
          style={{ fontSize: 13, color: 'var(--teal-700, #0f766e)', textDecoration: 'none', fontWeight: 600 }}
        >
          Export CSV
        </a>
      </div>
      <div style={{ overflowX: 'auto', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 520 }}>
          <thead>
            <tr>
              <th style={{ ...head, textAlign: 'left', position: 'sticky', left: 0, background: 'var(--surface)' }}>Metric</th>
              {data.periods.map((p) => <th key={p.end} style={head}>{p.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.key}>
                <td style={{ ...cell, textAlign: 'left', position: 'sticky', left: 0, background: 'var(--surface)' }}>{r.label}</td>
                {data.periods.map((p) => (
                  <td key={p.end} style={{ ...cell, color: r.byPeriod[p.end] ? 'var(--text)' : 'var(--gray-450, #98a1ab)' }}>
                    {r.byPeriod[p.end] || '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
