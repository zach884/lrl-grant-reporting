// pages/enrichment/[name].tsx — configure ONE enricher's gate (the detail screen).
//
// Mirrors the Field Mappings module: /enrichment lists enricher cards; clicking one lands here to
// edit WHEN it runs. The enricher TRANSFORM stays in code — this page only edits FILTERS: each filter
// is "field is one of [values]", and the filters combine with a top-level AND / OR. Add/remove filters
// freely; an empty list = always run. Field pickers read the live catalog (contact fields for contact
// enrichers, business fields for company ones), reusing the shared GateEditor per filter row.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Shell from '@/components/shell/Shell';
import GateEditor, { type GateFieldOpt } from '@/components/mapping/GateEditor';
import type { EnricherConfig, EnricherFilter, FilterCombine } from '@/lib/enrichment/configTypes';

const SECRET_KEY = 'mapping_admin_secret';

interface EnricherMeta { name: string; description?: string; produces: string[]; target: 'company' | 'contact'; sourceObject: string; gateWired: boolean }

const inputBase: React.CSSProperties = { border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--surface)', padding: '9px 12px', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-body)' };
const primaryBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 8, border: 'none', background: 'var(--brand)', color: 'var(--ink-900)', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 13, cursor: 'pointer', boxShadow: 'var(--shadow-brand)' };
const ghostBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 13px', borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text-secondary)', fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-sm)' };

function EnricherDetail() {
  const router = useRouter();
  const name = typeof router.query.name === 'string' ? router.query.name : '';
  const sourceObjectQ = typeof router.query.sourceObject === 'string' ? router.query.sourceObject : '';

  const [meta, setMeta] = useState<EnricherMeta | null>(null);
  const [fields, setFields] = useState<GateFieldOpt[]>([]);
  const [scalars, setScalars] = useState<string[]>([]);
  const [adminSecret, setAdminSecret] = useState('');

  const [enabled, setEnabled] = useState(true);
  const [combine, setCombine] = useState<FilterCombine>('AND');
  const [filters, setFilters] = useState<EnricherFilter[]>([]);

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
        setMeta(d.enricher ?? null);
        const config: EnricherConfig = d.config;
        setEnabled(config.enabled);
        setCombine(config.combine === 'OR' ? 'OR' : 'AND');
        setFilters(config.filters?.length ? config.filters : []);
      } catch (e: any) { if (!cancelled) setErr(e?.message ?? 'failed to load enricher'); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [name, sourceObjectQ]);

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

  function setFilterAt(i: number, patch: Partial<EnricherFilter>) { setFilters((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f))); touch(); }
  function addFilter() { setFilters((fs) => [...fs, { field: '', anyOf: [] }]); touch(); }
  function removeFilter(i: number) { setFilters((fs) => fs.filter((_, j) => j !== i)); touch(); }

  async function save() {
    if (!adminSecret) { setErr('Enter the admin secret to save.'); return; }
    setSaving(true); setErr(''); setMsg('');
    try {
      try { sessionStorage.setItem(SECRET_KEY, adminSecret); } catch { /* ignore */ }
      const body = { enabled, combine, filters: filters.filter((f) => f.field && f.anyOf.length) };
      const r = await fetch(`/api/enrichers/${encodeURIComponent(name)}?sourceObject=${encodeURIComponent(sourceObject)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-admin-secret': adminSecret }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `save failed (${r.status})`);
      setDirty(false); setMsg('Filters saved — the next run honors them.');
    } catch (e: any) { setErr(e?.message ?? 'save failed'); } finally { setSaving(false); }
  }

  const activeCount = filters.filter((f) => f.field && f.anyOf.length).length;

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
                <button type="button" style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={save}><i className="fa-solid fa-floppy-disk" />{saving ? 'Saving…' : 'Save filters'}</button>
              </div>
            </div>

            <div style={{ ...card, padding: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 4, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <i className="fa-solid fa-filter" style={{ color: 'var(--violet-700)', fontSize: 14 }} />
                  <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>Filters — when this enricher runs</span>
                </div>
                {activeCount > 1 && (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, color: 'var(--gray-500)' }}>Combine with</span>
                    <div style={{ display: 'flex', gap: 2, background: 'var(--gray-100)', padding: 3, borderRadius: 999 }}>
                      {(['AND', 'OR'] as FilterCombine[]).map((c) => {
                        const on = combine === c;
                        return <button key={c} type="button" onClick={() => { setCombine(c); touch(); }}
                          style={{ padding: '5px 14px', borderRadius: 999, border: 'none', cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12, letterSpacing: '.04em', background: on ? 'var(--surface)' : 'transparent', color: on ? 'var(--violet-700)' : 'var(--gray-500)', boxShadow: on ? 'var(--shadow-xs)' : 'none' }}>{c}</button>;
                      })}
                    </div>
                  </div>
                )}
              </div>
              <p style={{ margin: '0 0 18px', fontSize: 13, color: 'var(--gray-500)', maxWidth: '74ch' }}>
                Each filter runs the enricher only when a field is one of the chosen values. With no filters it runs on every {meta?.target === 'company' ? 'company' : 'contact'} that changes.
                {activeCount > 1 && <> Filters are combined with <b>{combine}</b>.</>}
              </p>

              {filters.length === 0 && (
                <div style={{ fontSize: 13, color: 'var(--gray-450)', padding: '10px 0 16px' }}>No filters — runs on every change. Add one to restrict it.</div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {filters.map((f, i) => (
                  <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, background: 'var(--surface-subtle, var(--surface))' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                      <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--gray-450)' }}>
                        {i === 0 ? 'Filter' : combine} {filters.length > 1 ? `· ${i + 1}` : ''}
                      </span>
                      <button type="button" onClick={() => removeFilter(i)} title="Remove filter"
                        style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--gray-400)', fontSize: 13, padding: 4 }}>
                        <i className="fa-solid fa-xmark" /> Remove
                      </button>
                    </div>
                    <GateEditor mode="list" includeVerb="match" fields={fields} scalars={scalars}
                      field={f.field} onField={(k) => setFilterAt(i, { field: k })} fieldLabel="Field"
                      values={f.anyOf} onValues={(v) => setFilterAt(i, { anyOf: v })} disabled={saving} />
                  </div>
                ))}
              </div>

              <button type="button" onClick={addFilter} style={{ ...ghostBtn, marginTop: 14 }}>
                <i className="fa-solid fa-plus" /> Add filter
              </button>

              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
                <div style={{ position: 'relative' }}>
                  <i className="fa-solid fa-key" style={{ position: 'absolute', left: 11, top: 11, fontSize: 11, color: 'var(--gray-400)' }} />
                  <input type="password" className="lrl-focus" placeholder="Admin secret" value={adminSecret} onChange={(e) => setAdminSecret(e.target.value)} style={{ ...inputBase, width: 200, paddingLeft: 30 }} />
                </div>
                <button type="button" style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={save}><i className="fa-solid fa-floppy-disk" />{saving ? 'Saving…' : 'Save filters'}</button>
                <span style={{ fontSize: 12.5, color: 'var(--gray-500)' }}>{activeCount ? `${activeCount} filter${activeCount > 1 ? 's' : ''} · ${combine}` : 'No filters — runs on every change'}</span>
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
