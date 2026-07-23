// pages/enrichment.tsx — Data Enrichment module.
//
// Registry-driven: the enricher list comes from /api/enrichers (the real defaultEnrichers +
// defaultContactEnrichers), never a hardcoded array. Contact enrichers expose an EDITABLE gate
// (status runOn + membership anyOf) that the engine reads live — editing it changes what the next
// run does, with no code change. Enricher TRANSFORMS stay in code; only when/where is config.
// A single-company dry-run spot-check (company enrichers) rounds out the page.

import { useCallback, useEffect, useState } from 'react';
import Shell from '@/components/shell/Shell';
import GateEditor, { type GateFieldOpt } from '@/components/mapping/GateEditor';
import type { EnricherListItem } from './api/enrichers/index';

const SECRET_KEY = 'mapping_admin_secret';

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

// ── One contact enricher: its info + an editable gate (status + membership) ──────────────────────
function ContactEnricherCard({ item, fields, scalars, adminSecret }: {
  item: EnricherListItem; fields: GateFieldOpt[]; scalars: string[]; adminSecret: string;
}) {
  const [enabled, setEnabled] = useState(item.config.enabled);
  const [statusField, setStatusField] = useState(item.config.gate?.field ?? '');
  const [runOn, setRunOn] = useState<string[]>(item.config.gate?.runOn ?? []);
  const [memberField, setMemberField] = useState(item.config.membership?.field ?? '');
  const [anyOf, setAnyOf] = useState<string[]>(item.config.membership?.anyOf ?? []);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(''); const [err, setErr] = useState(''); const [dirty, setDirty] = useState(false);
  const touch = useCallback(() => { setDirty(true); setMsg(''); setErr(''); }, []);

  async function save() {
    if (!adminSecret) { setErr('Enter the admin secret (below) to save.'); return; }
    setSaving(true); setErr(''); setMsg('');
    try {
      const body = {
        enabled,
        gate: statusField ? { field: statusField, runOn } : null,
        membership: memberField ? { field: memberField, anyOf } : null,
      };
      const r = await fetch(`/api/enrichers/${encodeURIComponent(item.name)}?sourceObject=${encodeURIComponent(item.sourceObject)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-admin-secret': adminSecret }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `save failed (${r.status})`);
      setDirty(false); setMsg('Gate saved — the next run honors it.');
    } catch (e: any) { setErr(e?.message ?? 'save failed'); } finally { setSaving(false); }
  }

  const mb = methodBadge('ai');
  return (
    <div style={{ ...card, padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, gap: 10 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>{item.name}</span>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--gray-600)' }}>
          <input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); touch(); }} /> Enabled
        </label>
      </div>
      {item.description && <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--gray-500)' }}>{item.description}</p>}
      <div style={{ fontSize: 12, color: 'var(--gray-450)', display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 14 }}>
        <span>→ <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--teal-700)' }}>{item.produces.join(', ')}</code></span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
        <div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12, color: 'var(--text)' }}>Status gate</span>
            <span style={{ fontSize: 11.5, color: 'var(--gray-450)' }}>runs only on these statuses</span>
          </div>
          <GateEditor mode="list" includeVerb="run on" fields={fields} scalars={scalars}
            field={statusField} onField={(k) => { setStatusField(k); touch(); }} fieldLabel="Status field"
            values={runOn} onValues={(v) => { setRunOn(v); touch(); }} disabled={saving} />
        </div>
        <div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12, color: 'var(--text)' }}>Membership gate</span>
            <span style={{ fontSize: 11.5, color: 'var(--gray-450)' }}>runs only for these tags</span>
          </div>
          <GateEditor mode="list" includeVerb="count as a member" fields={fields} scalars={scalars}
            field={memberField} onField={(k) => { setMemberField(k); touch(); }} fieldLabel="Membership field"
            values={anyOf} onValues={(v) => { setAnyOf(v); touch(); }} disabled={saving} />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 16, flexWrap: 'wrap' }}>
        <button type="button" style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={save}>
          <i className="fa-solid fa-floppy-disk" />{saving ? 'Saving…' : 'Save gate'}
        </button>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 600, color: dirty ? 'var(--yellow-700)' : 'var(--teal-700)' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: dirty ? 'var(--brand)' : 'var(--teal-500)' }} />{dirty ? 'Unsaved changes' : 'Saved'}
        </span>
        {(msg || err) && <span style={{ fontSize: 13, fontWeight: 600, color: err ? '#b42318' : 'var(--teal-700)' }}><i className={`fa-solid ${err ? 'fa-circle-exclamation' : 'fa-circle-check'}`} style={{ marginRight: 6 }} />{err || msg}</span>}
      </div>
    </div>
  );
}

export default function EnrichmentPage() {
  const [enrichers, setEnrichers] = useState<EnricherListItem[]>([]);
  const [contactFields, setContactFields] = useState<GateFieldOpt[]>([]);
  const [contactScalars, setContactScalars] = useState<string[]>([]);
  const [adminSecret, setAdminSecret] = useState('');
  const [loadErr, setLoadErr] = useState('');

  const [companyId, setCompanyId] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<{ applied: Applied[]; skipped: Skipped[] } | null>(null);

  // Keep sessionStorage in its own effect: in a sandboxed iframe it can throw, and it must never
  // abort the data fetches below (that would leave the cards stuck on "Loading…").
  useEffect(() => { try { setAdminSecret(sessionStorage.getItem(SECRET_KEY) ?? ''); } catch { /* ignore */ } }, []);

  useEffect(() => {
    (async () => {
      try { const r = await fetch('/api/enrichers'); if (r.ok) setEnrichers((await r.json()).enrichers ?? []); else setLoadErr((await r.json()).error ?? 'failed to load enrichers'); }
      catch (e: any) { setLoadErr(e?.message ?? 'failed to load enrichers'); }
    })();
    (async () => {
      try { const c = await fetch('/api/mapping/catalogs'); if (c.ok) { const d = await c.json(); setContactScalars(['id', 'fullName', ...d.contact.scalars]); setContactFields(d.contact.fields); } }
      catch { /* pickers just fall back to manual value entry */ }
    })();
  }, []);

  function onSecret(v: string) { setAdminSecret(v); try { sessionStorage.setItem(SECRET_KEY, v); } catch { /* ignore */ } }

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
            Enrichers fill and correct fields automatically — in real time when a record changes, and on a nightly sweep. Each write records its source and confidence for audit. The transform is in code; you control <b>when</b> each one runs below.
          </p>
        </div>

        {loadErr && <div style={{ fontSize: 13, color: '#b42318', marginBottom: 14 }}><i className="fa-solid fa-circle-exclamation" style={{ marginRight: 7 }} />{loadErr}</div>}

        {/* Company enrichers (registry, informational — they run on every company) */}
        <div style={{ marginBottom: 10 }}><span style={eyebrow}>Company enrichment</span></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14, marginBottom: 26 }}>
          {companyEnrichers.map((e) => (
            <div key={e.name} style={{ ...card, padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>{e.name}</span>
                <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 9, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--gray-450)', border: '1px solid var(--border-strong)', borderRadius: 999, padding: '2px 7px' }}>Company</span>
              </div>
              {e.description && <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--gray-500)' }}>{e.description}</p>}
              <div style={{ fontSize: 12, color: 'var(--gray-450)' }}>→ <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--teal-700)' }}>{e.produces.join(', ')}</code></div>
            </div>
          ))}
          {companyEnrichers.length === 0 && !loadErr && <div style={{ fontSize: 13, color: 'var(--gray-450)' }}>Loading…</div>}
        </div>

        {/* Contact enrichers — editable gates */}
        <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <span style={eyebrow}>Contact enrichment · editable gates</span>
          <div style={{ position: 'relative' }}>
            <i className="fa-solid fa-key" style={{ position: 'absolute', left: 11, top: 11, fontSize: 11, color: 'var(--gray-400)' }} />
            <input type="password" className="lrl-focus" placeholder="Admin secret" value={adminSecret} onChange={(e) => onSecret(e.target.value)} style={{ ...inputBase, width: 190, paddingLeft: 30 }} />
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 26 }}>
          {contactEnrichers.map((e) => (
            <ContactEnricherCard key={e.name} item={e} fields={contactFields} scalars={contactScalars} adminSecret={adminSecret} />
          ))}
          {contactEnrichers.length === 0 && !loadErr && <div style={{ fontSize: 13, color: 'var(--gray-450)' }}>Loading…</div>}
        </div>

        {/* Single-company spot check */}
        <div style={{ ...card, padding: 20 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text)', marginBottom: 4 }}>Spot-check a company</div>
          <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--gray-500)' }}>Preview what enrichment would write for one company — no changes are made. Paste a company ID (from its GHL URL).</p>
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
