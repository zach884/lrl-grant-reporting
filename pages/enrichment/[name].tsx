// pages/enrichment/[name].tsx — configure ONE enricher's gate (the detail screen).
//
// Mirrors the Field Mappings module: /enrichment lists enricher cards; clicking one lands here to
// edit WHEN it runs. The enricher TRANSFORM stays in code — this page only edits the status gate
// (runOn) + membership gate (anyOf), reusing the shared GateEditor with field pickers sourced from
// the live catalog (contact fields for contact enrichers, business fields for company ones). Every
// enricher is configurable, including ones that ship with no gate (pick a field → add values).

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Shell from '@/components/shell/Shell';
import GateEditor, { type GateFieldOpt } from '@/components/mapping/GateEditor';
import type { EnricherConfig } from '@/lib/enrichment/configTypes';

const SECRET_KEY = 'mapping_admin_secret';

interface EnricherMeta { name: string; description?: string; produces: string[]; target: 'company' | 'contact'; sourceObject: string; gateWired: boolean }

const inputBase: React.CSSProperties = { border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--surface)', padding: '9px 12px', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-body)' };
const primaryBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 8, border: 'none', background: 'var(--brand)', color: 'var(--ink-900)', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 13, cursor: 'pointer', boxShadow: 'var(--shadow-brand)' };
const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-sm)' };
const subhead: React.CSSProperties = { fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12.5, color: 'var(--text)' };
const hint: React.CSSProperties = { fontSize: 11.5, color: 'var(--gray-450)' };

function EnricherDetail() {
  const router = useRouter();
  const name = typeof router.query.name === 'string' ? router.query.name : '';
  const sourceObjectQ = typeof router.query.sourceObject === 'string' ? router.query.sourceObject : '';

  const [meta, setMeta] = useState<EnricherMeta | null>(null);
  const [fields, setFields] = useState<GateFieldOpt[]>([]);
  const [scalars, setScalars] = useState<string[]>([]);
  const [adminSecret, setAdminSecret] = useState('');

  const [enabled, setEnabled] = useState(true);
  const [statusField, setStatusField] = useState('');
  const [runOn, setRunOn] = useState<string[]>([]);
  const [memberField, setMemberField] = useState('');
  const [anyOf, setAnyOf] = useState<string[]>([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(''); const [err, setErr] = useState(''); const [dirty, setDirty] = useState(false);
  const touch = useCallback(() => { setDirty(true); setMsg(''); setErr(''); }, []);

  useEffect(() => { try { setAdminSecret(sessionStorage.getItem(SECRET_KEY) ?? ''); } catch { /* ignore */ } }, []);

  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const qs = sourceObjectQ ? `?sourceObject=${encodeURIComponent(sourceObjectQ)}` : '';
        const r = await fetch(`/api/enrichers/${encodeURIComponent(name)}${qs}`);
        const d = await r.json();
        if (cancelled) return;
        if (!r.ok) { setErr(d.error ?? 'failed to load enricher'); return; }
        const m: EnricherMeta | null = d.enricher ?? null;
        setMeta(m);
        const config: EnricherConfig = d.config;
        setEnabled(config.enabled);
        setStatusField(config.gate?.field ?? '');
        setRunOn(config.gate?.runOn ?? []);
        setMemberField(config.membership?.field ?? '');
        setAnyOf(config.membership?.anyOf ?? []);
      } catch (e: any) { if (!cancelled) setErr(e?.message ?? 'failed to load enricher'); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [name, sourceObjectQ]);

  // Load the field catalog for the enricher's side once we know its target.
  useEffect(() => {
    if (!meta) return;
    let cancelled = false;
    (async () => {
      try {
        const c = await fetch('/api/mapping/catalogs');
        if (!c.ok) return;
        const d = await c.json();
        if (cancelled) return;
        if (meta.target === 'company') { setScalars(d.business.scalars ?? []); setFields(d.business.fields ?? []); }
        else { setScalars(['id', 'fullName', ...(d.contact.scalars ?? [])]); setFields(d.contact.fields ?? []); }
      } catch { /* pickers fall back to manual value entry */ }
    })();
    return () => { cancelled = true; };
  }, [meta]);

  const sourceObject = meta?.sourceObject ?? sourceObjectQ ?? 'contact';

  async function save() {
    if (!adminSecret) { setErr('Enter the admin secret to save.'); return; }
    setSaving(true); setErr(''); setMsg('');
    try {
      try { sessionStorage.setItem(SECRET_KEY, adminSecret); } catch { /* ignore */ }
      const body = {
        enabled,
        gate: statusField ? { field: statusField, runOn } : null,
        membership: memberField ? { field: memberField, anyOf } : null,
      };
      const r = await fetch(`/api/enrichers/${encodeURIComponent(name)}?sourceObject=${encodeURIComponent(sourceObject)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-admin-secret': adminSecret }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `save failed (${r.status})`);
      setDirty(false); setMsg('Gate saved — the next run honors it.');
    } catch (e: any) { setErr(e?.message ?? 'save failed'); } finally { setSaving(false); }
  }

  const hasGate = Boolean(statusField || memberField);

  return (
    <Shell active="enrichment" breadcrumb="Data Enrichment" env="live">
      <div style={{ padding: '22px 30px', maxWidth: 1000, margin: '0 auto' }}>
        <a href="/enrichment" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600, color: 'var(--gray-500)', textDecoration: 'none', marginBottom: 16 }}>
          <i className="fa-solid fa-chevron-left" style={{ fontSize: 11 }} /> All enrichers
        </a>

        {loading && <div style={{ fontSize: 14, color: 'var(--gray-500)' }}>Loading…</div>}
        {!loading && err && !meta && <div style={{ fontSize: 13, color: '#b42318' }}><i className="fa-solid fa-circle-exclamation" style={{ marginRight: 7 }} />{err}</div>}

        {!loading && (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, marginBottom: 18, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--brand)' }}>
                  {meta?.target === 'company' ? 'Company enricher' : 'Contact enricher'}
                </span>
                <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 25, letterSpacing: '-.02em', margin: '6px 0 6px', color: 'var(--text)' }}>{name}</h1>
                {meta?.description && <p style={{ margin: 0, fontSize: 14, color: 'var(--gray-500)', maxWidth: '72ch' }}>{meta.description}</p>}
                {meta?.produces?.length ? <div style={{ marginTop: 8, fontSize: 12, color: 'var(--gray-450)' }}>→ <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--teal-700)' }}>{meta.produces.join(', ')}</code></div> : null}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 12 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: dirty ? 'var(--yellow-700)' : 'var(--teal-700)' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: dirty ? 'var(--brand)' : 'var(--teal-500)' }} />{dirty ? 'Unsaved changes' : 'All changes saved'}
                </span>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, color: 'var(--gray-600)' }}>
                  <input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); touch(); }} /> Enabled
                </label>
                <button type="button" style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={save}><i className="fa-solid fa-floppy-disk" />{saving ? 'Saving…' : 'Save gate'}</button>
              </div>
            </div>

            <div style={{ ...card, padding: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                <i className="fa-solid fa-shield-halved" style={{ color: 'var(--violet-700)', fontSize: 14 }} />
                <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>Gate — when this enricher runs</span>
              </div>
              <p style={{ margin: '0 0 18px', fontSize: 13, color: 'var(--gray-500)', maxWidth: '74ch' }}>
                Leave both gates empty to run on every {meta?.target === 'company' ? 'company' : 'contact'} that changes. Add a field + values to restrict it. Both gates must pass for the enricher to run.
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 22 }}>
                <div>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span style={subhead}>Status gate</span><span style={hint}>run only on these values</span>
                  </div>
                  <GateEditor mode="list" includeVerb="run on" fields={fields} scalars={scalars}
                    field={statusField} onField={(k) => { setStatusField(k); touch(); }} fieldLabel="Status field"
                    values={runOn} onValues={(v) => { setRunOn(v); touch(); }} disabled={saving} />
                </div>
                <div>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span style={subhead}>Membership gate</span><span style={hint}>run only when the field contains one of these</span>
                  </div>
                  <GateEditor mode="list" includeVerb="count as a member" fields={fields} scalars={scalars}
                    field={memberField} onField={(k) => { setMemberField(k); touch(); }} fieldLabel="Membership field"
                    values={anyOf} onValues={(v) => { setAnyOf(v); touch(); }} disabled={saving} />
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
                <div style={{ position: 'relative' }}>
                  <i className="fa-solid fa-key" style={{ position: 'absolute', left: 11, top: 11, fontSize: 11, color: 'var(--gray-400)' }} />
                  <input type="password" className="lrl-focus" placeholder="Admin secret" value={adminSecret} onChange={(e) => setAdminSecret(e.target.value)} style={{ ...inputBase, width: 200, paddingLeft: 30 }} />
                </div>
                <button type="button" style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={save}><i className="fa-solid fa-floppy-disk" />{saving ? 'Saving…' : 'Save gate'}</button>
                <span style={{ fontSize: 12.5, color: 'var(--gray-500)' }}>{hasGate ? 'Gated' : 'No gate — runs on every change'}</span>
                {(msg || err) && <span style={{ fontSize: 13, fontWeight: 600, color: err ? '#b42318' : 'var(--teal-700)' }}><i className={`fa-solid ${err ? 'fa-circle-exclamation' : 'fa-circle-check'}`} style={{ marginRight: 6 }} />{err || msg}</span>}
              </div>
            </div>
          </>
        )}
      </div>
    </Shell>
  );
}

export default EnricherDetail;
