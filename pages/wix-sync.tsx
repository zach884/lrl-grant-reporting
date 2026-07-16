// pages/wix-sync.tsx — GHL -> Wix CMS mapping-set editor.
//
// Pick a GHL source object (Contact for v1) + a Wix collection, map each source field to a
// column, set the match key, then Save / Dry-run. Reuses the searchable field picker + the
// LRL design system. Degrades gracefully when Wix creds aren't configured yet (banner).

import { useCallback, useEffect, useMemo, useState } from 'react';
import Shell from '@/components/shell/Shell';
import SearchableFieldSelect, { type CatalogFieldOpt } from '@/components/mapping/SearchableFieldSelect';

const SECRET_KEY = 'mapping_admin_secret';

interface WixCol { key: string; displayName: string; type: string; systemField?: boolean; readOnly?: boolean }
interface WixColSchema { id: string; displayName: string; displayField?: string; columns: WixCol[] }
interface Row { sourceFieldKey: string; targetColumnKey: string; transform?: string }
interface SetState {
  id?: string; name: string; wixCollectionId: string;
  matchSourceField: string; matchTargetColumn: string;
  policy: 'overwrite' | 'fill-empty'; enabled: boolean; rows: Row[];
}

const EMPTY: SetState = {
  name: '', wixCollectionId: '', matchSourceField: 'id', matchTargetColumn: 'ghlContactId',
  policy: 'overwrite', enabled: true, rows: [{ sourceFieldKey: '', targetColumnKey: '' }],
};

const selectBase: React.CSSProperties = {
  width: '100%', borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--surface)',
  padding: '7px 9px', fontSize: 13, fontFamily: 'var(--font-body)', color: 'var(--text)', cursor: 'pointer',
};
const primaryBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 8, border: 'none',
  background: 'var(--brand)', color: 'var(--ink-900)', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 13, cursor: 'pointer', boxShadow: 'var(--shadow-brand)',
};
const secondaryBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 15px', borderRadius: 8,
  border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text-secondary)',
  fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 13, cursor: 'pointer',
};

export default function WixSyncPage() {
  const [contactCatalog, setContactCatalog] = useState<{ scalars: string[]; fields: CatalogFieldOpt[] } | null>(null);
  const [collections, setCollections] = useState<{ id: string; displayName: string }[]>([]);
  const [wixError, setWixError] = useState('');
  const [sets, setSets] = useState<any[]>([]);
  const [schema, setSchema] = useState<WixColSchema | null>(null);
  const [editor, setEditor] = useState<SetState>(EMPTY);
  const [adminSecret, setAdminSecret] = useState('');
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  const [dryContactId, setDryContactId] = useState('');
  const [dryResult, setDryResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setAdminSecret(sessionStorage.getItem(SECRET_KEY) ?? ''); }, []);

  const loadSets = useCallback(async () => {
    try { const r = await fetch('/api/wix/sets'); if (r.ok) setSets((await r.json()).sets ?? []); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    // Independent fetches — a slow live-GHL catalog load must not block the Wix status.
    (async () => {
      try {
        const c = await fetch('/api/mapping/catalogs');
        if (c.ok) { const d = await c.json(); setContactCatalog(d.contact); }
      } catch { /* ignore */ }
    })();
    (async () => {
      try {
        const w = await fetch('/api/wix/collections');
        if (w.ok) setCollections((await w.json()).collections ?? []);
        else setWixError((await w.json()).error ?? 'Wix not configured');
      } catch (e: any) { setWixError(e?.message ?? 'Wix not reachable'); }
    })();
    loadSets();
  }, [loadSets]);

  // Source field picker options: contact scalars + id/fullName + custom fields.
  const source = useMemo(() => ({
    scalars: ['id', 'fullName', ...(contactCatalog?.scalars ?? [])],
    fields: contactCatalog?.fields ?? [],
  }), [contactCatalog]);

  const writableCols = useMemo(
    () => (schema?.columns ?? []).filter((c) => !c.systemField && c.type !== 'PAGE_LINK'),
    [schema],
  );

  async function loadSchema(collectionId: string) {
    setSchema(null);
    if (!collectionId) return;
    try {
      const r = await fetch(`/api/wix/collection?id=${encodeURIComponent(collectionId)}`);
      if (r.ok) setSchema(await r.json());
      else setErr((await r.json()).error ?? 'failed to load collection schema');
    } catch (e: any) { setErr(e?.message ?? 'failed to load collection'); }
  }

  function editRow(i: number, patch: Partial<Row>) {
    setEditor((s) => ({ ...s, rows: s.rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) }));
  }
  function addRow() { setEditor((s) => ({ ...s, rows: [...s.rows, { sourceFieldKey: '', targetColumnKey: '' }] })); }
  function removeRow(i: number) { setEditor((s) => ({ ...s, rows: s.rows.filter((_, idx) => idx !== i) })); }

  function loadIntoEditor(set: any) {
    setEditor({
      id: set.id, name: set.name, wixCollectionId: set.wixCollectionId,
      matchSourceField: set.matchSourceField, matchTargetColumn: set.matchTargetColumn,
      policy: set.policy, enabled: set.enabled, rows: set.rows.length ? set.rows : [{ sourceFieldKey: '', targetColumnKey: '' }],
    });
    loadSchema(set.wixCollectionId);
    setMsg(''); setErr(''); setDryResult(null);
  }
  function newSet() { setEditor(EMPTY); setSchema(null); setMsg(''); setErr(''); setDryResult(null); }

  async function save() {
    if (!adminSecret) { setErr('Enter the admin secret to save.'); return; }
    setBusy(true); setMsg(''); setErr('');
    try {
      sessionStorage.setItem(SECRET_KEY, adminSecret);
      const rows = editor.rows.filter((r) => r.sourceFieldKey && r.targetColumnKey);
      const body = JSON.stringify({ ...editor, rows });
      const url = editor.id ? `/api/wix/sets/${editor.id}` : '/api/wix/sets';
      const method = editor.id ? 'PUT' : 'POST';
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'x-admin-secret': adminSecret }, body });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `save failed (${r.status})`);
      setMsg(`Saved "${d.set.name}" · ${d.set.rows.length} field(s).`);
      setEditor((s) => ({ ...s, id: d.set.id }));
      loadSets();
    } catch (e: any) { setErr(e?.message ?? 'save failed'); } finally { setBusy(false); }
  }

  async function runDryRun() {
    if (!editor.id) { setErr('Save the set before running a dry-run.'); return; }
    if (!dryContactId.trim()) { setErr('Enter a contact id to dry-run.'); return; }
    setBusy(true); setErr(''); setDryResult(null);
    try {
      const r = await fetch('/api/wix/dry-run', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-secret': adminSecret },
        body: JSON.stringify({ setId: editor.id, contactId: dryContactId.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'dry-run failed');
      setDryResult(d.result);
    } catch (e: any) { setErr(e?.message ?? 'dry-run failed'); } finally { setBusy(false); }
  }

  const GRID = 'minmax(0,1.4fr) 150px minmax(0,1.4fr) 40px';

  return (
    <Shell active="wix-sync" breadcrumb="Website Sync" env="live">
      <div style={{ padding: '26px 30px', maxWidth: 1180, margin: '0 auto' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 18 }}>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--brand)' }}>GHL → Wix CMS</span>
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 27, letterSpacing: '-.02em', margin: 0, color: 'var(--text)' }}>Website Sync</h1>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--gray-500)' }}>
            Map a GHL object&apos;s fields to one Wix CMS collection and keep the website rows in sync from GHL.
          </p>
        </div>

        {wixError && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderRadius: 10, marginBottom: 16, fontSize: 13.5, background: 'var(--brand-tint)', color: 'var(--yellow-700)', border: '1px solid var(--brand)' }}>
            <i className="fa-solid fa-plug-circle-exclamation" />
            <span><b>Wix not connected yet.</b> Add the OAuth app credentials (WIX_* env) to load collections and sync. You can still draft a mapping set below. <span style={{ color: 'var(--gray-500)' }}>({wixError})</span></span>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 20, alignItems: 'start' }}>
          {/* saved sets */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--gray-450)' }}>Mapping sets</span>
              <button type="button" onClick={newSet} style={{ ...secondaryBtn, padding: '5px 10px', fontSize: 12 }}><i className="fa-solid fa-plus" /> New</button>
            </div>
            {sets.length === 0 && <div style={{ fontSize: 13, color: 'var(--gray-450)', padding: '8px 4px' }}>No sets yet.</div>}
            {sets.map((s) => (
              <button key={s.id} type="button" onClick={() => loadIntoEditor(s)}
                style={{ display: 'block', width: '100%', textAlign: 'left', border: '1px solid ' + (editor.id === s.id ? 'var(--teal-500)' : 'var(--border)'), borderRadius: 9, background: editor.id === s.id ? 'var(--accent-tint)' : 'var(--surface)', padding: '9px 11px', marginBottom: 7, cursor: 'pointer' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{s.name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--gray-450)' }}>{s.sourceObject} → {s.wixCollectionId} · {s.rowCount} fields {s.enabled ? '' : '· off'}</div>
              </button>
            ))}
          </div>

          {/* editor */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 20 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray-500)' }}>Set name</span>
                <input value={editor.name} onChange={(e) => setEditor((s) => ({ ...s, name: e.target.value }))} placeholder="Contact → Team" style={{ ...selectBase, cursor: 'text' }} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray-500)' }}>Wix collection</span>
                <select value={editor.wixCollectionId} style={selectBase}
                  onChange={(e) => { setEditor((s) => ({ ...s, wixCollectionId: e.target.value })); loadSchema(e.target.value); }}>
                  <option value="">— choose collection —</option>
                  {editor.wixCollectionId && !collections.some((c) => c.id === editor.wixCollectionId) && (
                    <option value={editor.wixCollectionId}>{editor.wixCollectionId}</option>
                  )}
                  {collections.map((c) => <option key={c.id} value={c.id}>{c.displayName} ({c.id})</option>)}
                </select>
              </label>
            </div>

            {/* match key */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--surface-subtle)', borderRadius: 9, marginBottom: 16 }}>
              <i className="fa-solid fa-key" style={{ color: 'var(--gray-400)', fontSize: 12 }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray-500)' }}>Match on</span>
              <div style={{ flex: 1 }}>
                <SearchableFieldSelect scalars={source.scalars} fields={source.fields} value={editor.matchSourceField} onChange={(v) => setEditor((s) => ({ ...s, matchSourceField: v }))} placeholder="source id field" />
              </div>
              <span style={{ color: 'var(--gray-400)' }}>=</span>
              <select value={editor.matchTargetColumn} style={{ ...selectBase, flex: 1 }} onChange={(e) => setEditor((s) => ({ ...s, matchTargetColumn: e.target.value }))}>
                <option value={editor.matchTargetColumn}>{editor.matchTargetColumn}</option>
                {writableCols.filter((c) => c.key !== editor.matchTargetColumn).map((c) => <option key={c.key} value={c.key}>{c.displayName} — {c.key}</option>)}
              </select>
            </div>

            {/* rows */}
            <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '0 2px 8px', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--gray-450)' }}>
              <span>GHL source field</span><span>Transform</span><span>Wix column</span><span />
            </div>
            {editor.rows.map((r, i) => {
              const col = writableCols.find((c) => c.key === r.targetColumnKey);
              return (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: GRID, gap: 10, alignItems: 'center', marginBottom: 8 }}>
                  <SearchableFieldSelect scalars={source.scalars} fields={source.fields} value={r.sourceFieldKey} onChange={(v) => editRow(i, { sourceFieldKey: v })} />
                  <select value={r.transform ?? ''} style={{ ...selectBase, fontSize: 12 }} onChange={(e) => editRow(i, { transform: e.target.value || undefined })}>
                    <option value="">auto</option>
                    <option value="html">html</option>
                    <option value="imageFromUpload">image import</option>
                    <option value="referenceFromOptions">reference</option>
                    <option value="arrayFromMultiSelect">array</option>
                    <option value="countryCode">country code</option>
                  </select>
                  <select value={r.targetColumnKey} style={{ ...selectBase, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--teal-700)' }} onChange={(e) => editRow(i, { targetColumnKey: e.target.value })}>
                    <option value="">— choose column —</option>
                    {r.targetColumnKey && !writableCols.some((c) => c.key === r.targetColumnKey) && <option value={r.targetColumnKey}>{r.targetColumnKey}</option>}
                    {writableCols.map((c) => <option key={c.key} value={c.key}>{c.displayName} — {c.key} · {c.type}</option>)}
                  </select>
                  <button type="button" onClick={() => removeRow(i)} title="Remove" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gray-400)' }}><i className="fa-solid fa-xmark" /></button>
                  {col && <div style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--gray-450)', paddingLeft: 2, marginTop: -2 }}>→ writes to <b>{col.displayName}</b> ({col.type})</div>}
                </div>
              );
            })}
            <button type="button" onClick={addRow} style={{ ...secondaryBtn, marginTop: 4 }}><i className="fa-solid fa-plus" /> Add field</button>

            {/* actions */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
              <div style={{ position: 'relative' }}>
                <i className="fa-solid fa-key" style={{ position: 'absolute', left: 11, top: 11, fontSize: 11, color: 'var(--gray-400)' }} />
                <input type="password" placeholder="Admin secret" value={adminSecret} onChange={(e) => setAdminSecret(e.target.value)} style={{ ...selectBase, width: 170, paddingLeft: 30, cursor: 'text' }} />
              </div>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, color: 'var(--gray-600)' }}>
                <input type="checkbox" checked={editor.enabled} onChange={(e) => setEditor((s) => ({ ...s, enabled: e.target.checked }))} /> Enabled
              </label>
              <button type="button" style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={save}><i className="fa-solid fa-floppy-disk" /> Save</button>
            </div>

            {(msg || err) && (
              <div style={{ marginTop: 12, fontSize: 13, fontWeight: 600, color: err ? '#b42318' : 'var(--teal-700)' }}>
                <i className={`fa-solid ${err ? 'fa-circle-exclamation' : 'fa-circle-check'}`} style={{ marginRight: 7 }} />{err || msg}
              </div>
            )}

            {/* dry-run spot check */}
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--gray-450)' }}>Dry-run spot check</span>
              <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                <input value={dryContactId} onChange={(e) => setDryContactId(e.target.value)} placeholder="GHL contact id" style={{ ...selectBase, cursor: 'text', flex: 1 }} />
                <button type="button" style={{ ...secondaryBtn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={runDryRun}><i className="fa-solid fa-flask" /> Preview</button>
              </div>
              {dryResult && (
                <pre style={{ marginTop: 12, background: 'var(--ink-900)', color: '#e6edf3', borderRadius: 10, padding: 14, fontSize: 12, overflowX: 'auto' }}>
{JSON.stringify(dryResult, null, 2)}
                </pre>
              )}
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}
