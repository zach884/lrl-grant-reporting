// components/mapping/WixConnectionEditor.tsx — a GHL→Wix connection (one-way) editor.
// Reuses the Wix set backend (/api/wix/*) but renders with the shared ToolObjectBand +
// ConnectionTable (locked push, violet destination, per-row transform), plus the Wix-specific
// match-key strip and dry-run spot-check. `id` is a set uuid, or 'new' to create one.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import ToolObjectBand, { type SideRef } from './ToolObjectBand';
import ConnectionTable, { type ConnRow, type ConnStatusFilter, type FieldOptions } from './ConnectionTable';
import SearchableFieldSelect, { type CatalogFieldOpt } from './SearchableFieldSelect';

const SECRET_KEY = 'mapping_admin_secret';
const FILTERS: { id: ConnStatusFilter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'active', label: 'Active' }, { id: 'review', label: 'Needs review' }, { id: 'off', label: 'Off' },
];
const primaryBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 8, border: 'none', background: 'var(--brand)', color: 'var(--ink-900)', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 13, cursor: 'pointer', boxShadow: 'var(--shadow-brand)' };
const secondaryBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 15px', borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text-secondary)', fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const inputBase: React.CSSProperties = { border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--surface)', padding: '9px 12px', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-body)' };

interface WixCol { key: string; displayName: string; type: string; systemField?: boolean }

export default function WixConnectionEditor({ id }: { id: string }) {
  const router = useRouter();
  const isNew = id === 'new';

  const [name, setName] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [matchSourceField, setMatchSourceField] = useState('id');
  const [matchTargetColumn, setMatchTargetColumn] = useState('ghlContactId');
  const [enabled, setEnabled] = useState(true);
  const [rows, setRows] = useState<ConnRow[]>([{ sourceKey: '', targetKey: '', direction: 'up' }]);

  const [collections, setCollections] = useState<{ id: string; displayName: string }[]>([]);
  const [cols, setCols] = useState<WixCol[]>([]);
  const [contact, setContact] = useState<FieldOptions>({ scalars: [], fields: [] });
  const [wixError, setWixError] = useState('');
  const [adminSecret, setAdminSecret] = useState('');
  const [savedId, setSavedId] = useState(isNew ? '' : id);
  const [query, setQuery] = useState(''); const [status, setStatus] = useState<ConnStatusFilter>('all');
  const [saving, setSaving] = useState(false); const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  const [dryContactId, setDryContactId] = useState(''); const [dryResult, setDryResult] = useState<any>(null); const [dirty, setDirty] = useState(false);

  useEffect(() => { setAdminSecret(sessionStorage.getItem(SECRET_KEY) ?? ''); }, []);

  const loadSchema = useCallback(async (cid: string) => {
    setCols([]);
    if (!cid) return;
    try { const r = await fetch(`/api/wix/collection?id=${encodeURIComponent(cid)}`); if (r.ok) setCols((await r.json()).columns ?? []); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    (async () => {
      try { const c = await fetch('/api/mapping/catalogs'); if (c.ok) { const d = await c.json(); setContact({ scalars: ['id', 'fullName', ...d.contact.scalars], fields: d.contact.fields }); } } catch { /* ignore */ }
    })();
    (async () => {
      try { const w = await fetch('/api/wix/collections'); if (w.ok) setCollections((await w.json()).collections ?? []); else setWixError((await w.json()).error ?? 'Wix not configured'); } catch (e: any) { setWixError(e?.message ?? 'Wix not reachable'); }
    })();
    if (!isNew) {
      (async () => {
        try {
          const r = await fetch(`/api/wix/sets/${id}`);
          if (!r.ok) { setErr('Mapping not found.'); return; }
          const s = (await r.json()).set;
          setName(s.name); setCollectionId(s.wixCollectionId); setMatchSourceField(s.matchSourceField); setMatchTargetColumn(s.matchTargetColumn); setEnabled(s.enabled);
          setRows(s.rows.length ? s.rows.map((x: any) => ({ sourceKey: x.sourceFieldKey, targetKey: x.targetColumnKey, transform: x.transform, direction: 'up' as const, enabled: true })) : [{ sourceKey: '', targetKey: '', direction: 'up' }]);
          loadSchema(s.wixCollectionId);
        } catch { setErr('Failed to load mapping.'); }
      })();
    }
  }, [id, isNew, loadSchema]);

  const target = useMemo<FieldOptions>(() => ({
    scalars: [], fields: cols.filter((c) => !c.systemField && c.type !== 'PAGE_LINK').map((c) => ({ fieldKey: c.key, name: c.displayName, dataType: c.type, folder: null } as CatalogFieldOpt)),
  }), [cols]);

  async function save() {
    if (!adminSecret) { setErr('Enter the admin secret to save.'); return; }
    if (!collectionId) { setErr('Choose a Wix collection first.'); return; }
    setSaving(true); setMsg(''); setErr('');
    try {
      sessionStorage.setItem(SECRET_KEY, adminSecret);
      const body = JSON.stringify({
        name: name || 'Contact → ' + collectionId, sourceObject: 'contact', wixCollectionId: collectionId,
        matchSourceField, matchTargetColumn, policy: 'overwrite', enabled,
        rows: rows.filter((r) => r.sourceKey && r.targetKey).map((r) => ({ sourceFieldKey: r.sourceKey, targetColumnKey: r.targetKey, transform: r.transform })),
      });
      const url = savedId ? `/api/wix/sets/${savedId}` : '/api/wix/sets';
      const r = await fetch(url, { method: savedId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-secret': adminSecret }, body });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `save failed (${r.status})`);
      setDirty(false);
      setMsg(`Saved "${d.set.name}" · ${d.set.rows.length} field(s).`);
      if (!savedId) { setSavedId(d.set.id); router.replace(`/mappings/${d.set.id}`, undefined, { shallow: true }); }
    } catch (e: any) { setErr(e?.message ?? 'save failed'); } finally { setSaving(false); }
  }

  async function runDryRun() {
    if (!savedId) { setErr('Save the mapping before running a dry-run.'); return; }
    if (!dryContactId.trim()) { setErr('Enter a contact id to dry-run.'); return; }
    setSaving(true); setErr(''); setDryResult(null);
    try {
      const r = await fetch('/api/wix/dry-run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-secret': adminSecret }, body: JSON.stringify({ setId: savedId, contactId: dryContactId.trim() }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'dry-run failed');
      setDryResult(d.result);
    } catch (e: any) { setErr(e?.message ?? 'dry-run failed'); } finally { setSaving(false); }
  }

  const targetSide: SideRef = { tool: 'wix', object: collectionId };
  const activeCount = rows.filter((r) => r.enabled !== false && r.sourceKey && r.targetKey).length;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, marginBottom: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0 }}>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--violet-700)' }}>GoHighLevel → Wix CMS</span>
          <input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} placeholder="Connection name" style={{ ...inputBase, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 22, border: '1px solid transparent', background: 'transparent', padding: '2px 0', color: 'var(--text)' }} />
          <p style={{ margin: 0, fontSize: 14, color: 'var(--gray-500)' }}><b style={{ color: 'var(--text)' }}>{activeCount}</b> field(s) pushing one-way to Wix CMS — this tool only receives from GoHighLevel.</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 12 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: dirty ? 'var(--yellow-700)' : 'var(--teal-700)' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: dirty ? 'var(--brand)' : 'var(--teal-500)' }} />{dirty ? 'Unsaved changes' : 'All changes saved'}
          </span>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, color: 'var(--gray-600)' }}>
            <input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setDirty(true); }} /> Enabled
          </label>
          <button type="button" style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={save}><i className="fa-solid fa-floppy-disk" />{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>

      {wixError && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderRadius: 10, marginBottom: 16, fontSize: 13.5, background: 'var(--brand-tint)', color: 'var(--yellow-700)', border: '1px solid var(--brand)' }}>
          <i className="fa-solid fa-plug-circle-exclamation" /> <span><b>Wix not connected.</b> Add the Wix credentials to load collections. ({wixError})</span>
        </div>
      )}

      <ToolObjectBand source={{ tool: 'ghl', object: 'contact' }} target={targetSide} wixCollections={collections}
        onChangeTarget={(s) => { if (s.tool === 'wix') { setCollectionId(s.object); loadSchema(s.object); setDirty(true); } }} />

      {/* match key strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, marginBottom: 14 }}>
        <i className="fa-solid fa-key" style={{ color: 'var(--gray-400)', fontSize: 12 }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray-500)' }}>Match on</span>
        <div style={{ flex: 1, maxWidth: 320 }}><SearchableFieldSelect scalars={contact.scalars} fields={contact.fields} value={matchSourceField} onChange={(v) => { setMatchSourceField(v); setDirty(true); }} placeholder="source id field" /></div>
        <span style={{ color: 'var(--gray-400)' }}>=</span>
        <select value={matchTargetColumn} style={{ ...inputBase, flex: 1, maxWidth: 320, cursor: 'pointer' }} onChange={(e) => { setMatchTargetColumn(e.target.value); setDirty(true); }}>
          <option value={matchTargetColumn}>{matchTargetColumn}</option>
          {target.fields.filter((c) => c.fieldKey !== matchTargetColumn).map((c) => <option key={c.fieldKey} value={c.fieldKey}>{c.name} — {c.fieldKey}</option>)}
        </select>
      </div>

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

      {(msg || err) && <div style={{ marginBottom: 12, fontSize: 13, fontWeight: 600, color: err ? '#b42318' : 'var(--teal-700)' }}><i className={`fa-solid ${err ? 'fa-circle-exclamation' : 'fa-circle-check'}`} style={{ marginRight: 7 }} />{err || msg}</div>}

      <ConnectionTable rows={rows} source={contact} target={target} oneWay showTransform destTone="violet" sourceLabel="Source field · Contact" targetLabel={`Wix column · ${collectionId || 'collection'}`} disabled={saving} filter={{ query, status }} onChange={(r) => { setRows(r); setDirty(true); setMsg(''); setErr(''); }} />

      {/* dry-run spot check */}
      <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--gray-450)' }}>Dry-run spot check</span>
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <input value={dryContactId} onChange={(e) => setDryContactId(e.target.value)} placeholder="GHL contact id" style={{ ...inputBase, flex: 1 }} />
          <button type="button" style={{ ...secondaryBtn, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={runDryRun}><i className="fa-solid fa-flask" /> Preview</button>
        </div>
        {dryResult && <pre style={{ marginTop: 12, background: 'var(--ink-900)', color: '#e6edf3', borderRadius: 10, padding: 14, fontSize: 12, overflowX: 'auto' }}>{JSON.stringify(dryResult, null, 2)}</pre>}
      </div>
    </>
  );
}
