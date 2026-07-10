// pages/enrichment.tsx — Data Enrichment module.
//
// Enrichment runs automatically (real-time on record change + nightly batch). This page is a
// light control surface: it lists the configured enrichers and offers a single-company
// dry-run spot-check (preview proposals with provenance, no writes).

import { useState } from 'react';
import AppShell from '@/components/shell/AppShell';

interface Provenance { source: string; method: string; confidence: number; rationale?: string }
interface Applied { businessKey: string; value: unknown; provenance: Provenance }
interface Skipped { businessKey: string; reason: string }

const ENRICHERS = [
  { name: 'County', produces: 'business.county', source: 'Census geocoder', method: 'api', confidence: '0.92', desc: 'Derives the county from the company address.' },
  { name: 'Geographic zone', produces: 'business.geo_zone', source: 'ArcGIS · SBA HUBZone + Opportunity Zone', method: 'api', confidence: '0.85', desc: 'HUBZone / Opportunity Zone / both / N/A by point-in-polygon on the address.' },
  { name: 'NAICS code', produces: 'business.naics_code', source: 'Claude (haiku) + official 2022 NAICS set', method: 'ai', confidence: 'model', desc: 'Classifies the 6-digit NAICS from the company description; validated against the official list.' },
  { name: 'LARA ID', produces: 'business.lara_id', source: '— not wired', method: '—', confidence: '—', desc: 'Michigan business registry lookup/verify. Coming later.', soon: true },
];

const methodBadge = (m: string) => {
  const map: Record<string, { bg: string; fg: string }> = {
    api: { bg: 'var(--accent-tint)', fg: 'var(--teal-700)' },
    ai: { bg: 'var(--brand-tint)', fg: 'var(--yellow-700)' },
  };
  return map[m] ?? { bg: 'var(--gray-100)', fg: 'var(--gray-450)' };
};

export default function EnrichmentPage() {
  const [companyId, setCompanyId] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<{ applied: Applied[]; skipped: Skipped[] } | null>(null);

  async function preview() {
    if (!companyId.trim()) { setErr('Enter a company ID.'); return; }
    setLoading(true); setErr(''); setResult(null);
    try {
      const res = await fetch('/api/enrich/company', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: companyId.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `failed (${res.status})`);
      setResult({ applied: data.applied ?? [], skipped: data.skipped ?? [] });
    } catch (e: any) {
      setErr(e?.message ?? 'preview failed');
    } finally {
      setLoading(false);
    }
  }

  const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-sm)' };

  return (
    <AppShell active="enrichment" breadcrumb="Data Enrichment" env="live">
      <div style={{ padding: '26px 30px', maxWidth: 1080, margin: '0 auto' }}>
        <div style={{ marginBottom: 20 }}>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--brand)' }}>Automated field completion</span>
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 27, letterSpacing: '-.02em', margin: '7px 0 6px', color: 'var(--text)' }}>Data Enrichment</h1>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--gray-500)', maxWidth: '72ch' }}>
            Enrichers fill and correct company fields automatically — in real time when a record changes, and nightly across every company. Each write is recorded with its source and confidence for audit.
          </p>
        </div>

        {/* Enricher cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14, marginBottom: 26 }}>
          {ENRICHERS.map((e) => {
            const mb = methodBadge(e.method);
            return (
              <div key={e.name} style={{ ...card, padding: 16, opacity: e.soon ? 0.6 : 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>{e.name}</span>
                  {e.soon
                    ? <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 9, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--gray-450)', border: '1px solid var(--border-strong)', borderRadius: 999, padding: '2px 7px' }}>Soon</span>
                    : <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 9, letterSpacing: '.1em', textTransform: 'uppercase', color: mb.fg, background: mb.bg, borderRadius: 999, padding: '3px 8px' }}>{e.method}</span>}
                </div>
                <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--gray-500)' }}>{e.desc}</p>
                <div style={{ fontSize: 12, color: 'var(--gray-450)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span>→ <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--teal-700)' }}>{e.produces}</code></span>
                  <span>Source: {e.source}</span>
                  <span>Confidence: {e.confidence}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Single-company spot check */}
        <div style={{ ...card, padding: 20 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text)', marginBottom: 4 }}>Spot-check a company</div>
          <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--gray-500)' }}>Preview what enrichment would write for one company — no changes are made. Paste a company ID (from its GHL URL).</p>
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
            <input
              type="text" className="lrl-focus" placeholder="Company ID (e.g. 6a4d574f4ebee4d821b49f16)" value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              style={{ flex: '1 1 320px', minWidth: 260, border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--surface)', padding: '9px 12px', fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}
            />
            <button type="button" onClick={preview} disabled={loading}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 8, border: 'none', background: 'var(--brand)', color: 'var(--ink-900)', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 13, cursor: 'pointer', boxShadow: 'var(--shadow-brand)', opacity: loading ? 0.5 : 1 }}>
              <i className="fa-solid fa-wand-magic-sparkles" />{loading ? 'Previewing…' : 'Preview enrichment'}
            </button>
          </div>
          {err && <div style={{ fontSize: 13, color: '#b42318', marginBottom: 10 }}><i className="fa-solid fa-circle-exclamation" style={{ marginRight: 7 }} />{err}</div>}

          {result && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--teal-700)', marginBottom: 8 }}>
                  Would write ({result.applied.length})
                </div>
                {result.applied.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--gray-450)' }}>Nothing to write — the company is already complete/correct.</div>
                ) : result.applied.map((a, i) => (
                  <div key={i} style={{ borderTop: i ? '1px solid var(--border)' : 'none', padding: '10px 0', display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--teal-700)' }}>{a.businessKey}</code>
                      <span style={{ color: 'var(--gray-400)' }}>=</span>
                      <span style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text)' }}>{String(a.value)}</span>
                      <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 9.5, letterSpacing: '.08em', textTransform: 'uppercase', color: methodBadge(a.provenance.method).fg, background: methodBadge(a.provenance.method).bg, borderRadius: 999, padding: '2px 7px' }}>
                        {a.provenance.source} · {Math.round((a.provenance.confidence ?? 0) * 100)}%
                      </span>
                    </div>
                    {a.provenance.rationale && <div style={{ fontSize: 12, color: 'var(--gray-500)' }}>{a.provenance.rationale}</div>}
                  </div>
                ))}
              </div>
              {result.skipped.length > 0 && (
                <div>
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--gray-450)', marginBottom: 8 }}>
                    Skipped ({result.skipped.length})
                  </div>
                  {result.skipped.map((s, i) => (
                    <div key={i} style={{ fontSize: 12.5, color: 'var(--gray-500)', padding: '3px 0' }}>
                      <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--gray-500)' }}>{s.businessKey}</code> — {s.reason}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
