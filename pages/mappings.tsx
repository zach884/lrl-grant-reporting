// pages/mappings.tsx — Field Mappings hub: a card grid of every sync connection
// (GHL↔GHL and GHL→Wix together). Click a card to open its editor at /mappings/[id].

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Shell from '@/components/shell/Shell';
import { TOOLS, objectLabel } from '@/lib/mapping/tools';

interface Side { tool: string; object: string }
interface ConnectionCard {
  id: string; name: string; source: Side; target: Side; oneWay: boolean;
  fieldCount: number; activeCount: number; enabled: boolean; updatedAt: string;
}

const primaryBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 16px', borderRadius: 8, border: 'none',
  background: 'var(--brand)', color: 'var(--ink-900)', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 13, cursor: 'pointer', boxShadow: 'var(--shadow-brand)',
};

function ObjChip({ side, wixNames }: { side: Side; wixNames: Record<string, string> }) {
  const t = TOOLS[side.tool];
  const tint = t?.tint ?? 'var(--gray-100)', fg = t?.fg ?? 'var(--gray-500)';
  const label = side.tool === 'wix' ? (wixNames[side.object] ?? side.object) : objectLabel(side.tool, side.object);
  const icon = side.tool === 'wix' ? 'fa-table-cells-large' : (t?.objects.find((o) => o.id === side.object)?.icon ?? 'fa-cube');
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <span style={{ width: 36, height: 36, borderRadius: 9, background: tint, color: fg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, flex: 'none' }}><i className={`fa-solid ${icon}`} /></span>
      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2, minWidth: 0 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 9, letterSpacing: '.1em', textTransform: 'uppercase', color: fg }}>{t?.short ?? side.tool}</span>
        <span style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label || '—'}</span>
      </span>
    </span>
  );
}

export default function MappingsHub() {
  const router = useRouter();
  const [connections, setConnections] = useState<ConnectionCard[]>([]);
  const [wixNames, setWixNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/mapping/connections');
        if (!r.ok) throw new Error((await r.json()).error ?? 'failed to load');
        setConnections((await r.json()).connections ?? []);
      } catch (e: any) { setError(e?.message ?? 'failed to load'); } finally { setLoading(false); }
      try { const w = await fetch('/api/wix/collections'); if (w.ok) { const m: Record<string, string> = {}; for (const c of (await w.json()).collections ?? []) m[c.id] = c.displayName; setWixNames(m); } } catch { /* ignore */ }
    })();
  }, []);

  return (
    <Shell active="mappings" breadcrumb="Field Mappings" env="live">
      <div style={{ padding: '26px 30px', maxWidth: 1180, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, marginBottom: 22 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--brand)' }}>Sync connections</span>
            <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 27, letterSpacing: '-.02em', margin: 0, color: 'var(--text)' }}>Field Mappings</h1>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--gray-500)', maxWidth: 620 }}>Every connection that keeps GoHighLevel — and your website — in sync. Open one to configure which fields map to each other.</p>
          </div>
          <button type="button" style={primaryBtn} onClick={() => router.push('/mappings/new')}><i className="fa-solid fa-plus" /> New mapping</button>
        </div>

        {loading && <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 24, fontSize: 14, color: 'var(--gray-500)' }}>Loading connections…</div>}
        {error && <div style={{ background: '#fde8e8', border: '1px solid #f5c2c0', borderRadius: 14, padding: 16, fontSize: 14, color: '#b42318' }}>{error}</div>}

        {!loading && !error && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(346px, 1fr))', gap: 16 }}>
            {connections.map((c) => (
              <button key={c.id} type="button" onClick={() => router.push(`/mappings/${c.id}`)}
                onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = 'var(--shadow-lg)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'var(--shadow-sm)'; }}
                style={{ textAlign: 'left', cursor: 'pointer', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-sm)', padding: 18, transition: 'transform .14s, box-shadow .14s', display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                  <span style={{ flex: 'none', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 9.5, letterSpacing: '.1em', textTransform: 'uppercase', padding: '4px 9px', borderRadius: 999, background: c.enabled ? 'var(--accent-tint)' : 'var(--gray-100)', color: c.enabled ? 'var(--teal-700)' : 'var(--gray-450)' }}>{c.enabled ? 'Active' : 'Off'}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 10, alignItems: 'center' }}>
                  <ObjChip side={c.source} wixNames={wixNames} />
                  <i className={`fa-solid ${c.oneWay ? 'fa-arrow-right-long' : 'fa-right-left'}`} style={{ color: 'var(--gray-400)', fontSize: 14 }} />
                  <span style={{ display: 'flex', justifyContent: 'flex-end' }}><ObjChip side={c.target} wixNames={wixNames} /></span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--gray-500)' }}>
                  <span><b style={{ color: 'var(--text)' }}>{c.fieldCount}</b> fields · {c.activeCount} active</span>
                  <span>{c.oneWay ? 'One-way' : 'Two-way'}{c.updatedAt ? ` · Updated ${new Date(c.updatedAt).toLocaleDateString()}` : ''}</span>
                </div>
              </button>
            ))}
            {connections.length === 0 && <div style={{ gridColumn: '1 / -1', padding: '40px', textAlign: 'center', color: 'var(--gray-450)', fontSize: 14, background: 'var(--surface)', border: '1px dashed var(--border-strong)', borderRadius: 14 }}>No connections yet. Click <b>New mapping</b> to create one.</div>}
          </div>
        )}
      </div>
    </Shell>
  );
}
