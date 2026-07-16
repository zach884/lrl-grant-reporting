// components/mapping/GhlConnectionEditor.tsx — editor for ANY GHL↔GHL connection (two-way).
//
// Loads the sync's object pair + association (meta), fetches each side's field catalog via
// object-catalog, and edits with the shared ConnectionTable. contact↔company keeps its existing
// save + Auto-suggest + live engine untouched; other pairs get a read-only DRY-RUN (traverse the
// chosen association from a source record and preview the planned writes) — no live writes yet.

import { useCallback, useEffect, useMemo, useState } from 'react';
import ToolObjectBand from './ToolObjectBand';
import ConnectionTable, { type ConnRow, type ConnStatusFilter, type FieldOptions } from './ConnectionTable';
import { objectLabel } from '@/lib/mapping/tools';
import type { FieldMapping } from '@/lib/mapping/types';

const SECRET_KEY = 'mapping_admin_secret';
const FILTERS: { id: ConnStatusFilter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'active', label: 'Active' }, { id: 'review', label: 'Needs review' }, { id: 'off', label: 'Off' },
];
const primaryBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 8, border: 'none', background: 'var(--brand)', color: 'var(--ink-900)', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 13, cursor: 'pointer', boxShadow: 'var(--shadow-brand)' };
const secondaryBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 15px', borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text-secondary)', fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const inputBase: React.CSSProperties = { border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--surface)', padding: '9px 12px', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-body)' };

interface Meta { sourceObject: string; destObject: string; associationId: string | null; name?: string }

function toRow(m: any): ConnRow {
  return { sourceKey: m.contactKey, targetKey: m.businessKey, direction: m.direction, enabled: m.enabled, note: m.note, transform: m.transform, issues: m.issues, mirrorDown: m.mirrorDown, holdValues: m.holdValues };
}
function toMapping(r: ConnRow): FieldMapping {
  const m: FieldMapping = { contactKey: r.sourceKey, businessKey: r.targetKey, direction: r.direction, mirrorDown: r.mirrorDown ?? false };
  if (typeof r.enabled === 'boolean') m.enabled = r.enabled;
  if (r.note) m.note = r.note;
  if (r.holdValues?.length) m.holdValues = r.holdValues;
  if (r.transform === 'countryCode') m.transform = 'countryCode';
  return m;
}

export default function GhlConnectionEditor({ slug = 'contact-company' }: { slug?: string }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [meta, setMeta] = useState<Meta | null>(null);
  const [source, setSource] = useState<FieldOptions>({ scalars: [], fields: [] });
  const [target, setTarget] = useState<FieldOptions>({ scalars: [], fields: [] });
  const [rows, setRows] = useState<ConnRow[]>([]);
  const [version, setVersion] = useState(0);
  const [updatedAt, setUpdatedAt] = useState('');
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState(''); const [status, setStatus] = useState<ConnStatusFilter>('all');
  const [adminSecret, setAdminSecret] = useState('');
  const [saving, setSaving] = useState(false); const [saveMsg, setSaveMsg] = useState(''); const [saveErr, setSaveErr] = useState('');
  const [dryId, setDryId] = useState(''); const [dryResult, setDryResult] = useState<any>(null);

  const isContactCompany = slug === 'contact-company';

  useEffect(() => { setAdminSecret(sessionStorage.getItem(SECRET_KEY) ?? ''); }, []);

  const load = useCallback(async () => {
    const res = await fetch(`/api/mapping/${slug}`);
    if (!res.ok) throw new Error((await res.json()).error ?? `load failed (${res.status})`);
    const data = await res.json();
    const m: Meta = data.meta ?? { sourceObject: 'contact', destObject: 'business', associationId: null };
    setMeta(m);
    setRows((data.mappings as any[]).map(toRow));
    setVersion(data.version ?? 0); setUpdatedAt(data.updatedAt ?? ''); setDirty(false);
    // Load each side's field catalog from its object.
    const [sc, tc] = await Promise.all([
      fetch(`/api/mapping/object-catalog?object=${encodeURIComponent(m.sourceObject)}`).then((r) => r.json()),
      fetch(`/api/mapping/object-catalog?object=${encodeURIComponent(m.destObject)}`).then((r) => r.json()),
    ]);
    setSource({ scalars: sc.scalars ?? [], fields: sc.fields ?? [] });
    setTarget({ scalars: tc.scalars ?? [], fields: tc.fields ?? [] });
  }, [slug]);

  useEffect(() => { (async () => { try { await load(); } catch (e: any) { setLoadError(e?.message ?? 'Failed to load'); } finally { setLoading(false); } })(); }, [load]);

  async function autoSuggest() {
    setSaveErr('');
    try {
      const res = await fetch(`/api/mapping/${slug}/suggest`);
      if (!res.ok) throw new Error((await res.json()).error ?? 'suggest failed');
      const { suggestions } = (await res.json()) as { suggestions: FieldMapping[] };
      const have = new Set(rows.map((r) => `${r.sourceKey}→${r.targetKey}`));
      const additions = suggestions.filter((s) => !have.has(`${s.contactKey}→${s.businessKey}`)).map((s) => ({ sourceKey: s.contactKey, targetKey: s.businessKey, direction: s.direction, mirrorDown: s.mirrorDown } as ConnRow));
      if (!additions.length) { setSaveMsg('No new suggestions.'); return; }
      setRows([...rows, ...additions]); setDirty(true); setSaveMsg(`Added ${additions.length} suggested row(s). Review, then Save.`);
    } catch (e: any) { setSaveErr(e?.message ?? 'suggest failed'); }
  }

  async function save() {
    if (!adminSecret) { setSaveErr('Enter the admin secret to save.'); return; }
    setSaving(true); setSaveMsg(''); setSaveErr('');
    try {
      sessionStorage.setItem(SECRET_KEY, adminSecret);
      const res = await fetch(`/api/mapping/${slug}/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-secret': adminSecret }, body: JSON.stringify({ mappings: rows.map(toMapping) }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `save failed (${res.status})`);
      await load();
      setSaveMsg(`Saved v${data.version} · ${data.count} mappings.`);
    } catch (e: any) { setSaveErr(e?.message ?? 'save failed'); } finally { setSaving(false); }
  }

  async function runDryRun() {
    if (!dryId.trim()) { setSaveErr('Enter a source record id to dry-run.'); return; }
    setSaving(true); setSaveErr(''); setDryResult(null);
    try {
      const r = await fetch('/api/mapping/dry-run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-secret': adminSecret }, body: JSON.stringify({ slug, sourceRecordId: dryId.trim() }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'dry-run failed');
      setDryResult(d.result);
    } catch (e: any) { setSaveErr(e?.message ?? 'dry-run failed'); } finally { setSaving(false); }
  }

  const activeCount = useMemo(() => rows.filter((r) => r.enabled !== false).length, [rows]);
  const srcLabel = meta ? objectLabel('ghl', meta.sourceObject) : '';
  const tgtLabel = meta ? objectLabel('ghl', meta.destObject) : '';

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, marginBottom: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--brand)' }}>GoHighLevel ⇄ GoHighLevel</span>
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 26, letterSpacing: '-.02em', margin: 0, color: 'var(--text)' }}>{meta?.name ?? (loading ? '…' : `${srcLabel} ⇄ ${tgtLabel}`)}</h1>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--gray-500)' }}>
            {loading ? 'Loading mappings…' : <><b style={{ color: 'var(--text)', fontWeight: 700 }}>{activeCount}</b> of {rows.length} fields — set direction per field.{version ? <span style={{ color: 'var(--gray-400)' }}> · v{version}{updatedAt ? ` · updated ${new Date(updatedAt).toLocaleDateString()}` : ''}</span> : null}</>}
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 12 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: dirty ? 'var(--yellow-700)' : 'var(--teal-700)' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: dirty ? 'var(--brand)' : 'var(--teal-500)' }} />{dirty ? 'Unsaved changes' : 'All changes saved'}
          </span>
          <div style={{ display: 'flex', gap: 10 }}>
            {isContactCompany && <button type="button" style={secondaryBtn} onClick={autoSuggest} disabled={loading || saving}><i className="fa-solid fa-wand-magic-sparkles" />Auto-suggest</button>}
            <button type="button" style={{ ...primaryBtn, opacity: loading || saving || !dirty ? 0.5 : 1 }} onClick={save} disabled={loading || saving || !dirty}><i className="fa-solid fa-floppy-disk" />{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </div>

      {meta && <ToolObjectBand source={{ tool: 'ghl', object: meta.sourceObject }} target={{ tool: 'ghl', object: meta.destObject }} />}

      {loadError && <div style={{ background: '#fde8e8', border: '1px solid #f5c2c0', borderRadius: 14, padding: 16, fontSize: 14, color: '#b42318' }}>{loadError}</div>}
      {loading && <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 24, fontSize: 14, color: 'var(--gray-500)' }}>Loading…</div>}

      {!loading && !loadError && meta && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 220 }}>
              <i className="fa-solid fa-magnifying-glass" style={{ position: 'absolute', left: 12, top: 11, fontSize: 12, color: 'var(--gray-400)' }} />
              <input type="text" className="lrl-focus" placeholder="Search source or destination field…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ ...inputBase, width: '100%', paddingLeft: 32 }} />
            </div>
            <div style={{ display: 'flex', gap: 2, background: 'var(--gray-100)', padding: 3, borderRadius: 999 }}>
              {FILTERS.map((f) => { const on = status === f.id; return <button key={f.id} type="button" onClick={() => setStatus(f.id)} style={{ padding: '6px 13px', borderRadius: 999, border: 'none', cursor: 'pointer', fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 12.5, background: on ? 'var(--surface)' : 'transparent', color: on ? 'var(--text)' : 'var(--gray-500)', boxShadow: on ? 'var(--shadow-xs)' : 'none' }}>{f.label}</button>; })}
            </div>
            <div style={{ position: 'relative' }}>
              <i className="fa-solid fa-key" style={{ position: 'absolute', left: 11, top: 11, fontSize: 11, color: 'var(--gray-400)' }} />
              <input type="password" className="lrl-focus" placeholder="Admin secret" value={adminSecret} onChange={(e) => setAdminSecret(e.target.value)} style={{ ...inputBase, width: 190, paddingLeft: 30 }} />
            </div>
          </div>
          {(saveMsg || saveErr) && <div style={{ marginBottom: 12, fontSize: 13, fontWeight: 600, color: saveErr ? '#b42318' : 'var(--teal-700)' }}><i className={`fa-solid ${saveErr ? 'fa-circle-exclamation' : 'fa-circle-check'}`} style={{ marginRight: 7 }} />{saveErr || saveMsg}</div>}

          <ConnectionTable rows={rows} source={source} target={target} oneWay={false} destTone="teal" sourceLabel={`Source field · ${srcLabel}`} targetLabel={`Destination · ${tgtLabel}`} disabled={saving} filter={{ query, status }} onChange={(r) => { setRows(r); setDirty(true); setSaveMsg(''); setSaveErr(''); }} />

          {meta.associationId && (
            <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--gray-450)' }}>Dry-run spot check (read-only)</span>
              <p style={{ margin: '4px 0 8px', fontSize: 12.5, color: 'var(--gray-450)' }}>Enter a {srcLabel} record id — we&apos;ll traverse the association to its {tgtLabel}(s) and show the planned writes. No writes happen.</p>
              <div style={{ display: 'flex', gap: 10 }}>
                <input value={dryId} onChange={(e) => setDryId(e.target.value)} placeholder={`${srcLabel} record id`} style={{ ...inputBase, flex: 1 }} />
                <button type="button" style={{ ...secondaryBtn, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={runDryRun}><i className="fa-solid fa-flask" /> Preview</button>
              </div>
              {dryResult && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 13, color: 'var(--gray-600)', marginBottom: 6 }}>{dryResult.counterpartCount} counterpart(s){dryResult.note ? ` · ${dryResult.note}` : ''}</div>
                  <pre style={{ background: 'var(--ink-900)', color: '#e6edf3', borderRadius: 10, padding: 14, fontSize: 12, overflowX: 'auto' }}>{JSON.stringify(dryResult.counterparts, null, 2)}</pre>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}
