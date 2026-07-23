// pages/enrichment/[name].tsx — configure ONE enricher's gate (the detail screen).
//
// Mirrors the Field Mappings module: /enrichment lists enricher cards; clicking one lands here to
// edit WHEN it runs. The enricher TRANSFORM stays in code — this page edits a two-level boolean of
// FILTERS: each filter is "field is one of [values]"; filters combine inside a GROUP (AND/OR), and
// groups combine at the top level (AND/OR). So you can build status ∈ {Approved} AND (tag ∋ {Team}
// OR {EIR}), (A AND B) OR (C AND D), etc. Add/remove groups + filters freely; empty gate = always
// run. Field pickers read the live catalog (contact vs business fields), reusing the shared GateEditor.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Shell from '@/components/shell/Shell';
import GateEditor, { type GateFieldOpt } from '@/components/mapping/GateEditor';
import type { EnricherConfig, EnricherGroup, FilterCombine } from '@/lib/enrichment/configTypes';

const SECRET_KEY = 'mapping_admin_secret';

interface EnricherMeta { name: string; description?: string; produces: string[]; target: 'company' | 'contact' | 'resource'; sourceObject: string; gateWired: boolean }

const inputBase: React.CSSProperties = { border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--surface)', padding: '9px 12px', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-body)' };
const primaryBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 8, border: 'none', background: 'var(--brand)', color: 'var(--ink-900)', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 13, cursor: 'pointer', boxShadow: 'var(--shadow-brand)' };
const ghostBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 13px', borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text-secondary)', fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-sm)' };

/** A small AND/OR segmented toggle. */
function CombineToggle({ value, onChange, disabled }: { value: FilterCombine; onChange: (v: FilterCombine) => void; disabled?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 2, background: 'var(--gray-100)', padding: 3, borderRadius: 999 }}>
      {(['AND', 'OR'] as FilterCombine[]).map((c) => {
        const on = value === c;
        return <button key={c} type="button" disabled={disabled} onClick={() => onChange(c)}
          style={{ padding: '4px 12px', borderRadius: 999, border: 'none', cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11.5, letterSpacing: '.04em', background: on ? 'var(--surface)' : 'transparent', color: on ? 'var(--violet-700)' : 'var(--gray-500)', boxShadow: on ? 'var(--shadow-xs)' : 'none' }}>{c}</button>;
      })}
    </div>
  );
}

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
  const [groups, setGroups] = useState<EnricherGroup[]>([]);

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
        setGroups(config.groups?.length ? config.groups : []);
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
        // Resources (custom objects) load their own object catalog; company/contact come from /catalogs.
        if (meta.target === 'resource') {
          const c = await fetch(`/api/mapping/object-catalog?object=${encodeURIComponent(meta.sourceObject)}`);
          if (!c.ok) return;
          const d = await c.json();
          if (cancelled) return;
          setScalars(d.scalars ?? []); setFields(d.fields ?? []);
          return;
        }
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

  // --- group / filter mutations ---
  function setGroupAt(gi: number, patch: Partial<EnricherGroup>) { setGroups((gs) => gs.map((g, j) => (j === gi ? { ...g, ...patch } : g))); touch(); }
  function addGroup() { setGroups((gs) => [...gs, { combine: 'AND', filters: [{ field: '', anyOf: [] }] }]); touch(); }
  function removeGroup(gi: number) { setGroups((gs) => gs.filter((_, j) => j !== gi)); touch(); }
  function setFilterAt(gi: number, fi: number, patch: Partial<{ field: string; anyOf: string[] }>) {
    setGroups((gs) => gs.map((g, j) => (j === gi ? { ...g, filters: g.filters.map((f, k) => (k === fi ? { ...f, ...patch } : f)) } : g))); touch();
  }
  function addFilter(gi: number) { setGroups((gs) => gs.map((g, j) => (j === gi ? { ...g, filters: [...g.filters, { field: '', anyOf: [] }] } : g))); touch(); }
  function removeFilter(gi: number, fi: number) { setGroups((gs) => gs.map((g, j) => (j === gi ? { ...g, filters: g.filters.filter((_, k) => k !== fi) } : g))); touch(); }

  async function save() {
    if (!adminSecret) { setErr('Enter the admin secret to save.'); return; }
    setSaving(true); setErr(''); setMsg('');
    try {
      try { sessionStorage.setItem(SECRET_KEY, adminSecret); } catch { /* ignore */ }
      const cleaned = groups
        .map((g) => ({ combine: g.combine, filters: g.filters.filter((f) => f.field && f.anyOf.length) }))
        .filter((g) => g.filters.length);
      const body = { enabled, combine, groups: cleaned };
      const r = await fetch(`/api/enrichers/${encodeURIComponent(name)}?sourceObject=${encodeURIComponent(sourceObject)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-admin-secret': adminSecret }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `save failed (${r.status})`);
      setDirty(false); setMsg('Gate saved — the next run honors it.');
    } catch (e: any) { setErr(e?.message ?? 'save failed'); } finally { setSaving(false); }
  }

  const activeGroupCount = groups.filter((g) => g.filters.some((f) => f.field && f.anyOf.length)).length;

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
                  {meta?.target === 'company' ? 'Company enricher' : meta?.target === 'resource' ? 'Resource enricher' : 'Contact enricher'}
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
                <i className="fa-solid fa-filter" style={{ color: 'var(--violet-700)', fontSize: 14 }} />
                <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>Gate — when this enricher runs</span>
              </div>
              <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--gray-500)', maxWidth: '76ch' }}>
                Each filter runs the enricher only when a field is one of the chosen values. Filters combine inside a group; groups combine at the top. With no filters it runs on every {meta?.target === 'company' ? 'company' : meta?.target === 'resource' ? 'resource' : 'contact'} that changes.
              </p>

              {/* top-level combine across groups */}
              {activeGroupCount > 1 && (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 9, marginBottom: 14, fontSize: 12.5, color: 'var(--gray-600)' }}>
                  <span>Match</span>
                  <CombineToggle value={combine} onChange={(v) => { setCombine(v); touch(); }} disabled={saving} />
                  <span>of the groups below</span>
                </div>
              )}

              {groups.length === 0 && (
                <div style={{ fontSize: 13, color: 'var(--gray-450)', padding: '4px 0 14px' }}>No filters — runs on every change. Add a group to restrict it.</div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {groups.map((g, gi) => (
                  <div key={gi}>
                    {gi > 0 && <div style={{ margin: '2px 0 10px', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.1em', color: 'var(--violet-700)' }}>{combine}</div>}
                    <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, background: 'var(--surface-subtle, var(--surface))' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
                          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--gray-450)' }}>Group {groups.length > 1 ? gi + 1 : ''}</span>
                          {g.filters.filter((f) => f.field && f.anyOf.length).length > 1 && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--gray-500)' }}>
                              match <CombineToggle value={g.combine} onChange={(v) => setGroupAt(gi, { combine: v })} disabled={saving} /> of
                            </span>
                          )}
                        </div>
                        <button type="button" onClick={() => removeGroup(gi)} title="Remove group"
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--gray-400)', fontSize: 12.5, padding: 4 }}>
                          <i className="fa-solid fa-xmark" /> Remove group
                        </button>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        {g.filters.map((f, fi) => (
                          <div key={fi} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <GateEditor mode="list" includeVerb="match" fields={fields} scalars={scalars}
                                field={f.field} onField={(k) => setFilterAt(gi, fi, { field: k })} fieldLabel={fi === 0 ? 'Field' : `${g.combine} · field`}
                                values={f.anyOf} onValues={(v) => setFilterAt(gi, fi, { anyOf: v })} disabled={saving} />
                            </div>
                            <button type="button" onClick={() => removeFilter(gi, fi)} title="Remove filter"
                              style={{ marginTop: 26, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--gray-400)', fontSize: 13, padding: 4 }}>
                              <i className="fa-solid fa-xmark" />
                            </button>
                          </div>
                        ))}
                      </div>

                      <button type="button" onClick={() => addFilter(gi)} style={{ ...ghostBtn, marginTop: 12, padding: '6px 11px', fontSize: 12.5 }}>
                        <i className="fa-solid fa-plus" style={{ fontSize: 11 }} /> Add filter
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <button type="button" onClick={addGroup} style={{ ...ghostBtn, marginTop: 14 }}>
                <i className="fa-solid fa-layer-group" /> Add group
              </button>

              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
                <div style={{ position: 'relative' }}>
                  <i className="fa-solid fa-key" style={{ position: 'absolute', left: 11, top: 11, fontSize: 11, color: 'var(--gray-400)' }} />
                  <input type="password" className="lrl-focus" placeholder="Admin secret" value={adminSecret} onChange={(e) => setAdminSecret(e.target.value)} style={{ ...inputBase, width: 200, paddingLeft: 30 }} />
                </div>
                <button type="button" style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={save}><i className="fa-solid fa-floppy-disk" />{saving ? 'Saving…' : 'Save gate'}</button>
                <span style={{ fontSize: 12.5, color: 'var(--gray-500)' }}>{activeGroupCount ? `${activeGroupCount} group${activeGroupCount > 1 ? 's' : ''} · ${combine}` : 'No filters — runs on every change'}</span>
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
