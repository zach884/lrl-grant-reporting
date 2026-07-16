// components/mapping/NewConnection.tsx — create a new mapping connection.
//
// The destination is ASSOCIATION-DRIVEN: once you pick a GHL source object, the destination
// list only enables GHL objects that share an association with it (unrelated objects show as
// disabled "no association"), and when several associations connect the same pair you pick
// which one. Wix collections are always offered as one-way destinations.

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { TOOLS, objectLabel, scalarLinksFrom } from '@/lib/mapping/tools';

const SECRET_KEY = 'mapping_admin_secret';

interface AssocDef { id: string; key: string; first: { objectKey: string; label: string }; second: { objectKey: string; label: string } }

const inputBase: React.CSSProperties = { border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--surface)', padding: '9px 12px', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-body)', width: '100%' };
const primaryBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 16px', borderRadius: 8, border: 'none', background: 'var(--brand)', color: 'var(--ink-900)', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 13, cursor: 'pointer', boxShadow: 'var(--shadow-brand)' };

export default function NewConnection() {
  const router = useRouter();
  const [defs, setDefs] = useState<AssocDef[]>([]);
  const [collections, setCollections] = useState<{ id: string; displayName: string }[]>([]);
  const [source, setSource] = useState('contact');
  const [dest, setDest] = useState(''); // encoded: "ghl:<obj>:<assocId>" | "wix:<collectionId>"
  const [name, setName] = useState('');
  const [adminSecret, setAdminSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { setAdminSecret(sessionStorage.getItem(SECRET_KEY) ?? ''); }, []);
  useEffect(() => {
    (async () => {
      try { const r = await fetch('/api/mapping/associations'); if (r.ok) setDefs((await r.json()).associations ?? []); } catch { /* ignore */ }
      try { const w = await fetch('/api/wix/collections'); if (w.ok) setCollections((await w.json()).collections ?? []); } catch { /* ignore */ }
    })();
  }, []);

  // Object label map from the association graph (covers custom objects); fall back to tools.ts.
  const labelOf = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of defs) { m[d.first.objectKey] = m[d.first.objectKey] ?? d.first.label; m[d.second.objectKey] = m[d.second.objectKey] ?? d.second.label; }
    return (k: string) => TOOLS.ghl.objects.find((o) => o.id === k)?.label ?? m[k] ?? objectLabel('ghl', k);
  }, [defs]);

  // All GHL objects that appear anywhere in the association graph (+ the standard three).
  const allObjects = useMemo(() => {
    const set = new Set<string>(['contact', 'business', 'opportunity']);
    for (const d of defs) { set.add(d.first.objectKey); set.add(d.second.objectKey); }
    return Array.from(set);
  }, [defs]);

  // Associations reachable from `source`: [{ targetObject, associationId, sideLabel }]
  const reachable = useMemo(() => {
    const out: { targetObject: string; associationId: string; sideLabel: string }[] = [];
    for (const d of defs) {
      if (d.first.objectKey === source) out.push({ targetObject: d.second.objectKey, associationId: d.id, sideLabel: d.first.label });
      else if (d.second.objectKey === source) out.push({ targetObject: d.first.objectKey, associationId: d.id, sideLabel: d.second.label });
    }
    return out;
  }, [defs, source]);

  const scalarLinks = useMemo(() => scalarLinksFrom(source), [source]);

  async function create() {
    if (!adminSecret) { setErr('Enter the admin secret to create.'); return; }
    if (!dest) { setErr('Choose a destination.'); return; }
    setBusy(true); setErr('');
    try {
      sessionStorage.setItem(SECRET_KEY, adminSecret);
      if (dest.startsWith('ghl|')) {
        const [, targetObject, spec] = dest.split('|'); // spec = associationId OR "scalar:on:field"
        const nm = name || `${labelOf(source)} → ${labelOf(targetObject)}`;
        const r = await fetch('/api/mapping/connections', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-secret': adminSecret }, body: JSON.stringify({ name: nm, sourceObject: source, destObject: targetObject, associationId: spec }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? 'create failed');
        router.push(`/mappings/${d.connection.slug}`);
      } else if (dest.startsWith('wix|')) {
        const collectionId = dest.slice(4);
        const nm = name || `${labelOf(source)} → ${collectionId}`;
        const r = await fetch('/api/wix/sets', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-secret': adminSecret }, body: JSON.stringify({ name: nm, sourceObject: 'contact', wixCollectionId: collectionId, matchSourceField: 'id', matchTargetColumn: 'ghlContactId', policy: 'overwrite', enabled: true, rows: [] }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? 'create failed');
        router.push(`/mappings/${d.set.id}`);
      }
    } catch (e: any) { setErr(e?.message ?? 'create failed'); } finally { setBusy(false); }
  }

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 18 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--brand)' }}>New connection</span>
        <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 26, letterSpacing: '-.02em', margin: 0, color: 'var(--text)' }}>Create a mapping</h1>
        <p style={{ margin: 0, fontSize: 14, color: 'var(--gray-500)' }}>Pick a source object; the destination lists only objects it can sync with (via a GHL association) plus your Wix collections.</p>
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-sm)', padding: 20, maxWidth: 720 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 16, alignItems: 'end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray-500)' }}>Source object (GoHighLevel)</span>
            <select value={source} style={{ ...inputBase, cursor: 'pointer' }} onChange={(e) => { setSource(e.target.value); setDest(''); }}>
              {allObjects.map((o) => <option key={o} value={o}>{labelOf(o)}</option>)}
            </select>
          </label>

          <span style={{ paddingBottom: 9, color: 'var(--gray-400)' }}><i className="fa-solid fa-arrow-right-long" /></span>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray-500)' }}>Destination</span>
            <select value={dest} style={{ ...inputBase, cursor: 'pointer' }} onChange={(e) => setDest(e.target.value)}>
              <option value="">— choose destination —</option>
              <optgroup label="GoHighLevel">
                {allObjects.filter((o) => o !== source).map((o) => {
                  const assocs = reachable.filter((r) => r.targetObject === o);
                  const scalars = scalarLinks.filter((l) => l.target === o);
                  const total = assocs.length + scalars.length;
                  if (!total) return <option key={o} value="" disabled>{labelOf(o)} — no link</option>;
                  const multi = total > 1;
                  return [
                    ...assocs.map((a) => (
                      <option key={a.associationId} value={`ghl|${o}|${a.associationId}`}>{labelOf(o)}{multi ? ` · via ${a.sideLabel}` : ''}</option>
                    )),
                    ...scalars.map((l) => (
                      <option key={`s-${l.field}`} value={`ghl|${o}|scalar:${l.on}:${l.field}`}>{labelOf(o)}{multi ? ` · linked by ${l.field}` : ''}</option>
                    )),
                  ];
                })}
              </optgroup>
              {collections.length > 0 && (
                <optgroup label="Wix CMS (one-way)">
                  {collections.map((c) => <option key={c.id} value={`wix|${c.id}`}>{c.displayName}</option>)}
                </optgroup>
              )}
            </select>
          </label>
        </div>

        <div style={{ marginTop: 16, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Connection name (optional)" style={{ ...inputBase, flex: '1 1 240px' }} />
          <div style={{ position: 'relative' }}>
            <i className="fa-solid fa-key" style={{ position: 'absolute', left: 11, top: 11, fontSize: 11, color: 'var(--gray-400)' }} />
            <input type="password" placeholder="Admin secret" value={adminSecret} onChange={(e) => setAdminSecret(e.target.value)} style={{ ...inputBase, width: 180, paddingLeft: 30 }} />
          </div>
          <button type="button" style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={create}><i className="fa-solid fa-plus" /> Create</button>
        </div>
        {err && <div style={{ marginTop: 12, fontSize: 13, fontWeight: 600, color: '#b42318' }}><i className="fa-solid fa-circle-exclamation" style={{ marginRight: 7 }} />{err}</div>}
        <p style={{ marginTop: 14, marginBottom: 0, fontSize: 12, color: 'var(--gray-450)' }}>
          GHL↔GHL connections open in the two-way editor with a read-only dry-run. Objects with no association to the source are shown but disabled.
        </p>
      </div>
    </>
  );
}
