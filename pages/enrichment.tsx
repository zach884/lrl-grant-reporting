// pages/enrichment.tsx — Data Enrichment module (the enricher list / hub).
//
// Registry-driven: the enricher list comes from /api/enrichers (the real defaultEnrichers +
// defaultContactEnrichers), never a hardcoded array. Each card links to /enrichment/[name] to
// configure WHEN it runs (its gate) — the same click-into-a-detail-screen pattern as Field Mappings.
// Every enricher is configurable, including ones that ship with no gate. Enricher TRANSFORMS stay in
// code; only when/where is config. A single-company dry-run spot-check rounds out the page.

import { useEffect, useState } from 'react';
import Shell from '@/components/shell/Shell';
import type { EnricherListItem } from './api/enrichers/index';

interface Provenance { source: string; method: string; confidence: number; rationale?: string }
interface Applied { businessKey: string; value: unknown; provenance: Provenance }
interface Skipped { businessKey: string; reason: string }

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-sm)' };
const inputBase: React.CSSProperties = { border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--surface)', padding: '9px 12px', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-body)' };
const primaryBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 8, border: 'none', background: 'var(--brand)', color: 'var(--ink-900)', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 13, cursor: 'pointer', boxShadow: 'var(--shadow-brand)' };
const eyebrow: React.CSSProperties = { fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--brand)' };

const methodBadge = (m: string) => {
  const map: Record<string, { bg: string; fg: string }> = {
    api: { bg: 'var(--accent-tint)', fg: 'var(--teal-700)' },
    ai: { bg: 'var(--brand-tint)', fg: 'var(--yellow-700)' },
  };
  return map[m] ?? { bg: 'var(--gray-100)', fg: 'var(--gray-450)' };
};

/** One-line summary of an enricher's gate, for the card. */
function gateSummary(config: EnricherListItem['config']): { text: string; tone: 'gated' | 'open' | 'off' } {
  if (config.enabled === false) return { text: 'Disabled', tone: 'off' };
  const parts: string[] = [];
  if (config.gate?.field && config.gate.runOn?.length) parts.push(`${config.gate.field} ∈ {${config.gate.runOn.join(', ')}}`);
  if (config.membership?.field && config.membership.anyOf?.length) parts.push(`${config.membership.field} ∋ {${config.membership.anyOf.join(', ')}}`);
  if (parts.length) return { text: parts.join('  ·  '), tone: 'gated' };
  return { text: 'No gate — runs on every change', tone: 'open' };
}

function EnricherCard({ e }: { e: EnricherListItem }) {
  const g = gateSummary(e.config);
  const toneColor = g.tone === 'gated' ? 'var(--teal-700)' : g.tone === 'off' ? 'var(--gray-450)' : 'var(--yellow-700)';
  const toneBg = g.tone === 'gated' ? 'var(--accent-tint)' : g.tone === 'off' ? 'var(--gray-100)' : 'var(--brand-tint)';
  return (
    <a href={`/enrichment/${encodeURIComponent(e.name)}?sourceObject=${encodeURIComponent(e.sourceObject)}`}
      style={{ ...card, padding: 16, textDecoration: 'none', color: 'inherit', display: 'flex', flexDirection: 'column', gap: 8, transition: 'box-shadow .12s, border-color .12s' }}
      onMouseEnter={(ev) => { ev.currentTarget.style.borderColor = 'var(--border-strong)'; ev.currentTarget.style.boxShadow = 'var(--shadow-md, 0 8px 24px rgba(0,0,0,.10))'; }}
      onMouseLeave={(ev) => { ev.currentTarget.style.borderColor = 'var(--border)'; ev.currentTarget.style.boxShadow = 'var(--shadow-sm)'; }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>{e.name}</span>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 9, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--gray-450)', border: '1px solid var(--border-strong)', borderRadius: 999, padding: '2px 7px' }}>
          {e.target === 'company' ? 'Company' : 'Contact'}
        </span>
      </div>
      {e.description && <p style={{ margin: 0, fontSize: 13, color: 'var(--gray-500)' }}>{e.description}</p>}
      <div style={{ fontSize: 12, color: 'var(--gray-450)' }}>→ <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--teal-700)' }}>{e.produces.join(', ')}</code></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
        <i className="fa-solid fa-shield-halved" style={{ fontSize: 11, color: toneColor }} />
        <span style={{ fontSize: 11.5, fontWeight: 600, color: toneColor, background: toneBg, borderRadius: 6, padding: '3px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }} title={g.text}>{g.text}</span>
        <i className="fa-solid fa-chevron-right" style={{ fontSize: 11, color: 'var(--gray-400)' }} />
      </div>
    </a>
  );
}

export default function EnrichmentPage() {
  const [enrichers, setEnrichers] = useState<EnricherListItem[]>([]);
  const [loadErr, setLoadErr] = useState('');

  const [companyId, setCompanyId] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<{ applied: Applied[]; skipped: Skipped[] } | null>(null);

  useEffect(() => {
    (async () => {
      try { const r = await fetch('/api/enrichers'); if (r.ok) setEnrichers((await r.json()).enrichers ?? []); else setLoadErr((await r.json()).error ?? 'failed to load enrichers'); }
      catch (e: any) { setLoadErr(e?.message ?? 'failed to load enrichers'); }
    })();
  }, []);

  async function preview() {
    if (!companyId.trim()) { setErr('Enter a company ID.'); return; }
    setLoading(true); setErr(''); setResult(null);
    try {
      const res = await fetch('/api/enrich/company', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ companyId: companyId.trim() }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `failed (${res.status})`);
      setResult({ applied: data.applied ?? [], skipped: data.skipped ?? [] });
    } catch (e: any) { setErr(e?.message ?? 'preview failed'); } finally { setLoading(false); }
  }

  const companyEnrichers = enrichers.filter((e) => e.target === 'company');
  const contactEnrichers = enrichers.filter((e) => e.target === 'contact');

  return (
    <Shell active="enrichment" breadcrumb="Data Enrichment" env="live">
      <div style={{ padding: '26px 30px', maxWidth: 1080, margin: '0 auto' }}>
        <div style={{ marginBottom: 20 }}>
          <span style={eyebrow}>Automated field completion</span>
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 27, letterSpacing: '-.02em', margin: '7px 0 6px', color: 'var(--text)' }}>Data Enrichment</h1>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--gray-500)', maxWidth: '72ch' }}>
            Enrichers fill and correct fields automatically — in real time when a record changes, and on a nightly sweep. Each write records its source and confidence for audit. The transform is in code; <b>click an enricher to control when it runs</b>.
          </p>
        </div>

        {loadErr && <div style={{ fontSize: 13, color: '#b42318', marginBottom: 14 }}><i className="fa-solid fa-circle-exclamation" style={{ marginRight: 7 }} />{loadErr}</div>}

        <div style={{ marginBottom: 10 }}><span style={eyebrow}>Company enrichment</span></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14, marginBottom: 26 }}>
          {companyEnrichers.map((e) => <EnricherCard key={e.name} e={e} />)}
          {companyEnrichers.length === 0 && !loadErr && <div style={{ fontSize: 13, color: 'var(--gray-450)' }}>Loading…</div>}
        </div>

        <div style={{ marginBottom: 10 }}><span style={eyebrow}>Contact enrichment</span></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14, marginBottom: 26 }}>
          {contactEnrichers.map((e) => <EnricherCard key={e.name} e={e} />)}
          {contactEnrichers.length === 0 && !loadErr && <div style={{ fontSize: 13, color: 'var(--gray-450)' }}>Loading…</div>}
        </div>

        {/* Single-company spot check */}
        <div style={{ ...card, padding: 20 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text)', marginBottom: 4 }}>Spot-check a company</div>
          <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--gray-500)' }}>Preview what enrichment would write for one company — no changes are made. Honors each enricher&apos;s gate. Paste a company ID (from its GHL URL).</p>
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
            <input type="text" className="lrl-focus" placeholder="Company ID (e.g. 6a4d574f4ebee4d821b49f16)" value={companyId} onChange={(e) => setCompanyId(e.target.value)}
              style={{ flex: '1 1 320px', minWidth: 260, ...inputBase, fontFamily: 'var(--font-mono)' }} />
            <button type="button" onClick={preview} disabled={loading} style={{ ...primaryBtn, opacity: loading ? 0.5 : 1 }}>
              <i className="fa-solid fa-wand-magic-sparkles" />{loading ? 'Previewing…' : 'Preview enrichment'}
            </button>
          </div>
          {err && <div style={{ fontSize: 13, color: '#b42318', marginBottom: 10 }}><i className="fa-solid fa-circle-exclamation" style={{ marginRight: 7 }} />{err}</div>}

          {result && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--teal-700)', marginBottom: 8 }}>Would write ({result.applied.length})</div>
                {result.applied.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--gray-450)' }}>Nothing to write — the company is already complete/correct (or gated out).</div>
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
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--gray-450)', marginBottom: 8 }}>Skipped ({result.skipped.length})</div>
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
    </Shell>
  );
}
