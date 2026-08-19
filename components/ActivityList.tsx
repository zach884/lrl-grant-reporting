// components/ActivityList.tsx — a company's activity timeline.
//
// Shows ALL types, not just the manually logged ones: an ingested appointment, a form-fed grant or
// metrics snapshot and a hand-logged phone call are the same kind of thing here. The company link
// comes from the association graph, so this is the real "what has happened with this client" view.

import { useEffect, useState } from 'react';

export interface ActivitySummary {
  id: string;
  type: string;
  typeLabel: string;
  name: string;
  date: string;
  owner: string;
  notes: string;
  details: Array<{ key: string; label: string; value: string }>;
}

const TYPE_TONE: Record<string, string> = {
  intake: 'var(--accent-tint, #e6f4f1)',
  technical_assistance: 'var(--brand-tint, #fdf3dd)',
  introduction_referral: 'var(--violet-100, #ece9fd)',
  workshop_event: 'var(--gray-150, #eceef1)',
  grant: 'var(--brand-tint, #fdf3dd)',
  metrics: 'var(--gray-150, #eceef1)',
};

export default function ActivityList({ companyId, refreshKey }: { companyId: string; refreshKey: number }) {
  const [rows, setRows] = useState<ActivitySummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!companyId) {
      setRows([]);
      return;
    }
    (async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch(`/api/activities/list?companyId=${encodeURIComponent(companyId)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Failed to load activities');
        setRows(data.activities ?? []);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [companyId, refreshKey]);

  if (!companyId) return null;
  if (loading) return <div style={{ fontSize: 13, color: 'var(--gray-500)' }}>Loading timeline…</div>;
  if (error) return <div style={{ fontSize: 13, color: 'var(--red-600, #b3261e)' }}>{error}</div>;
  if (!rows.length) return <div style={{ fontSize: 13, color: 'var(--gray-500)' }}>Nothing logged for this company yet.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.map((a) => (
        <details
          key={a.id}
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}
        >
          <summary style={{ padding: '10px 13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', listStyle: 'none' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--gray-500)', minWidth: 88 }}>{a.date || '—'}</span>
            <span style={{
              fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase',
              background: TYPE_TONE[a.type] ?? 'var(--gray-100)', borderRadius: 999, padding: '2px 8px',
            }}>
              {a.typeLabel}
            </span>
            <span style={{ fontSize: 13.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
            {a.owner && <span style={{ fontSize: 12, color: 'var(--gray-500)' }}>{a.owner}</span>}
          </summary>
          <div style={{ padding: '0 13px 12px', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {a.notes && <div style={{ whiteSpace: 'pre-wrap' }}>{a.notes}</div>}
            {a.details.length > 0 && (
              <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'minmax(140px, max-content) 1fr', gap: '4px 14px' }}>
                {a.details.map((d) => (
                  <div key={d.key} style={{ display: 'contents' }}>
                    <dt style={{ color: 'var(--gray-500)' }}>{d.label}</dt>
                    <dd style={{ margin: 0 }}>{d.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}
