// pages/index.tsx — Activity logging.
//
// Rebuilt for Sprint B (2026-08-19). Most activities are INGESTED from their real source —
// appointments, forms, Wix attendance, an opportunity reaching a pipeline stage — so this page is
// the BACK-UP path: an offline meeting, a phone call, a drop-in, or anything a source missed.
// See docs/sprints/activity-tracking.md.
//
// Company-first, because every funder report aggregates by company and v1's contact-only records
// could not be counted at all.

import { useEffect, useState } from 'react';
import Shell from '@/components/shell/Shell';
import ActivityForm from '@/components/ActivityForm';
import ActivityList from '@/components/ActivityList';
import CompanySearch, { type CompanyOption } from '@/components/CompanySearch';
import { parseGHLContext } from '@/lib/auth';
import type { GHLUser } from '@/types';

const card: React.CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14,
  boxShadow: 'var(--shadow-sm)', padding: 20,
};
const h2: React.CSSProperties = { margin: 0, fontSize: 15, fontWeight: 700 };
const sub: React.CSSProperties = { margin: '4px 0 0', fontSize: 13, color: 'var(--gray-500)' };

export default function Home() {
  const [user, setUser] = useState<GHLUser | null>(null);
  const [tab, setTab] = useState<'log' | 'timeline'>('log');
  const [timelineCompany, setTimelineCompany] = useState<CompanyOption | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setUser(parseGHLContext(new URLSearchParams(window.location.search)));
  }, []);

  const actor = { name: user?.userName || undefined, email: user?.userEmail || undefined };

  return (
    <Shell active="activities" breadcrumb="Activities" env="live">
      <div style={{ padding: '26px 30px', maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Activities</h1>
          <p style={sub}>
            Appointments, forms, event attendance and program acceptances are logged automatically.
            Use this to record what those miss — an offline meeting, a call, a drop-in.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          {(['log', 'timeline'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              style={{
                padding: '7px 14px', borderRadius: 999, fontSize: 13.5, cursor: 'pointer',
                border: `1px solid ${tab === t ? 'var(--teal-700, #0f766e)' : 'var(--border-strong)'}`,
                background: tab === t ? 'var(--accent-tint, #e6f4f1)' : 'var(--surface)',
                color: tab === t ? 'var(--teal-700, #0f766e)' : 'var(--text)', fontWeight: tab === t ? 600 : 400,
              }}
            >
              {t === 'log' ? 'Log an activity' : 'Company timeline'}
            </button>
          ))}
        </div>

        {tab === 'log' ? (
          <div style={card}>
            <ActivityForm
              actor={actor}
              onSaved={(companyId) => {
                setRefreshKey((k) => k + 1);
                if (timelineCompany?.id === companyId) setRefreshKey((k) => k + 1);
              }}
            />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={card}>
              <h2 style={h2}>Company timeline</h2>
              <p style={sub}>Everything recorded for one company — logged by hand or ingested from its source.</p>
              <div style={{ marginTop: 12 }}>
                <CompanySearch value={timelineCompany} onChange={setTimelineCompany} />
              </div>
            </div>
            <ActivityList companyId={timelineCompany?.id ?? ''} refreshKey={refreshKey} />
          </div>
        )}
      </div>
    </Shell>
  );
}
