// pages/mappings.tsx — Field Mappings module (contact⇄company sync).
//
// Reskinned to the LRL Sync Engine design system (dark ink shell + teal/yellow workspace).
// All behavior is unchanged: load rows annotated against live catalogs, edit the table,
// auto-suggest pairings, and save (admin secret, held in sessionStorage) — live immediately.

import { useCallback, useEffect, useMemo, useState } from 'react';
import AppShell from '@/components/shell/AppShell';
import MappingTable, { type EditableRow, type MapperCatalogs, type StatusFilter } from '@/components/mapping/MappingTable';
import type { MappingIssue, ResolvedFieldMapping, FieldMapping } from '@/lib/mapping/types';

const SLUG = 'contact-company';
const SECRET_KEY = 'mapping_admin_secret';

function toRow(m: ResolvedFieldMapping): EditableRow {
  return {
    contactKey: m.contactKey, businessKey: m.businessKey, direction: m.direction,
    mirrorDown: m.mirrorDown, enabled: m.enabled, note: m.note,
    holdValues: m.holdValues, transform: m.transform, issues: m.issues,
  };
}
function toMapping(r: EditableRow): FieldMapping {
  const m: FieldMapping = { contactKey: r.contactKey, businessKey: r.businessKey, direction: r.direction, mirrorDown: r.mirrorDown };
  if (typeof r.enabled === 'boolean') m.enabled = r.enabled;
  if (r.note) m.note = r.note;
  if (r.holdValues?.length) m.holdValues = r.holdValues;
  if (r.transform) m.transform = r.transform;
  return m;
}

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'review', label: 'Needs review' },
  { id: 'off', label: 'Off' },
];

export default function MappingsPage() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [catalogs, setCatalogs] = useState<MapperCatalogs | null>(null);
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [issues, setIssues] = useState<MappingIssue[]>([]);
  const [version, setVersion] = useState<number>(0);
  const [updatedAt, setUpdatedAt] = useState<string>('');
  const [dirty, setDirty] = useState(false);

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');

  const [adminSecret, setAdminSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [saveErr, setSaveErr] = useState('');

  useEffect(() => { setAdminSecret(sessionStorage.getItem(SECRET_KEY) ?? ''); }, []);

  const loadSync = useCallback(async () => {
    const res = await fetch(`/api/mapping/${SLUG}`);
    if (!res.ok) throw new Error((await res.json()).error ?? `load failed (${res.status})`);
    const data = await res.json();
    setRows((data.mappings as ResolvedFieldMapping[]).map(toRow));
    setIssues(data.issues ?? []);
    setVersion(data.version ?? 0);
    setUpdatedAt(data.updatedAt ?? '');
    setDirty(false);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const catRes = await fetch('/api/mapping/catalogs');
        if (!catRes.ok) throw new Error((await catRes.json()).error ?? 'catalogs failed');
        setCatalogs(await catRes.json());
        await loadSync();
      } catch (e: any) {
        setLoadError(e?.message ?? 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [loadSync]);

  function onRowsChange(next: EditableRow[]) {
    setRows(next); setDirty(true); setSaveMsg(''); setSaveErr('');
  }

  async function autoSuggest() {
    setSaveErr('');
    try {
      const res = await fetch(`/api/mapping/${SLUG}/suggest`);
      if (!res.ok) throw new Error((await res.json()).error ?? 'suggest failed');
      const { suggestions } = (await res.json()) as { suggestions: FieldMapping[] };
      const have = new Set(rows.map((r) => `${r.contactKey}→${r.businessKey}`));
      const additions = suggestions.filter((s) => !have.has(`${s.contactKey}→${s.businessKey}`)).map((s) => ({ ...s } as EditableRow));
      if (!additions.length) { setSaveMsg('No new suggestions — all suggested pairs are already present.'); return; }
      setRows([...rows, ...additions]); setDirty(true);
      setSaveMsg(`Added ${additions.length} suggested row(s). Review, then Save.`);
    } catch (e: any) { setSaveErr(e?.message ?? 'suggest failed'); }
  }

  async function save() {
    if (!adminSecret) { setSaveErr('Enter the admin secret to save.'); return; }
    setSaving(true); setSaveMsg(''); setSaveErr('');
    try {
      sessionStorage.setItem(SECRET_KEY, adminSecret);
      const res = await fetch(`/api/mapping/${SLUG}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': adminSecret },
        body: JSON.stringify({ mappings: rows.map(toMapping) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `save failed (${res.status})`);
      await loadSync();
      setSaveMsg(`Saved v${data.version} · ${data.count} mappings · live now (no redeploy).`);
    } catch (e: any) { setSaveErr(e?.message ?? 'save failed'); }
    finally { setSaving(false); }
  }

  const activeCount = useMemo(() => rows.filter((r) => r.enabled !== false).length, [rows]);
  const errorCount = issues.filter((i) => i.level === 'error').length;
  const warnCount = issues.filter((i) => i.level === 'warning').length;

  const primaryBtn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 8, border: 'none',
    background: 'var(--brand)', color: 'var(--ink-900)', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 13,
    cursor: 'pointer', boxShadow: 'var(--shadow-brand)',
  };
  const secondaryBtn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 15px', borderRadius: 8,
    border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text-secondary)',
    fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 13, cursor: 'pointer',
  };

  return (
    <AppShell active="mappings" breadcrumb="Field Mappings" env="live">
      <div style={{ padding: '26px 30px', maxWidth: 1180, margin: '0 auto' }}>
        {/* ---- title block ---- */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, marginBottom: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--brand)' }}>Contact ⇄ Company sync</span>
            <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 27, letterSpacing: '-.02em', margin: 0, color: 'var(--text)' }}>Field Mappings</h1>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--gray-500)' }}>
              {loading ? 'Loading mappings…' : <><b style={{ color: 'var(--text)', fontWeight: 700 }}>{activeCount}</b> of {rows.length} fields syncing to GoHighLevel — set direction and transforms per field.
                {version ? <span style={{ color: 'var(--gray-400)' }}> · v{version}{updatedAt ? ` · updated ${new Date(updatedAt).toLocaleDateString()}` : ''}</span> : null}</>}
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 12 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: dirty ? 'var(--yellow-700)' : 'var(--teal-700)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: dirty ? 'var(--brand)' : 'var(--teal-500)' }} />
              {dirty ? 'Unsaved changes' : 'All changes saved'}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button type="button" style={secondaryBtn} onClick={autoSuggest} disabled={loading || saving}><i className="fa-solid fa-wand-magic-sparkles" />Auto-suggest</button>
              <button type="button" style={{ ...primaryBtn, opacity: loading || saving || !dirty ? 0.5 : 1 }} onClick={save} disabled={loading || saving || !dirty}><i className="fa-solid fa-floppy-disk" />{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>

        {loading && <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 24, fontSize: 14, color: 'var(--gray-500)' }}>Loading…</div>}
        {loadError && <div style={{ background: '#fde8e8', border: '1px solid #f5c2c0', borderRadius: 14, padding: 16, fontSize: 14, color: '#b42318' }}>{loadError}</div>}

        {!loading && !loadError && catalogs && (
          <>
            {(errorCount > 0 || warnCount > 0) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderRadius: 10, marginBottom: 14, fontSize: 13.5, fontWeight: 600,
                background: errorCount ? '#fde8e8' : 'var(--brand-tint)', color: errorCount ? '#b42318' : 'var(--yellow-700)', border: `1px solid ${errorCount ? '#f5c2c0' : 'var(--brand)'}` }}>
                <i className={`fa-solid ${errorCount ? 'fa-circle-exclamation' : 'fa-triangle-exclamation'}`} />
                {errorCount > 0 && <span>{errorCount} error{errorCount > 1 ? 's' : ''}</span>}
                {errorCount > 0 && warnCount > 0 && <span>·</span>}
                {warnCount > 0 && <span>{warnCount} warning{warnCount > 1 ? 's' : ''}</span>}
                <span style={{ fontWeight: 500 }}>across mappings — see the flagged rows below.</span>
              </div>
            )}

            {/* ---- controls: search + status filter + admin secret ---- */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
              <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 220 }}>
                <i className="fa-solid fa-magnifying-glass" style={{ position: 'absolute', left: 12, top: 11, fontSize: 12, color: 'var(--gray-400)' }} />
                <input type="text" className="lrl-focus" placeholder="Search source or destination field…" value={query} onChange={(e) => setQuery(e.target.value)}
                  style={{ width: '100%', border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--surface)', padding: '9px 12px 9px 32px', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-body)' }} />
              </div>
              <div style={{ display: 'flex', gap: 2, background: 'var(--gray-100)', padding: 3, borderRadius: 999 }}>
                {FILTERS.map((f) => {
                  const on = status === f.id;
                  return (
                    <button key={f.id} type="button" onClick={() => setStatus(f.id)}
                      style={{ padding: '6px 13px', borderRadius: 999, border: 'none', cursor: 'pointer', fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 12.5,
                        background: on ? 'var(--surface)' : 'transparent', color: on ? 'var(--text)' : 'var(--gray-500)', boxShadow: on ? 'var(--shadow-xs)' : 'none' }}>
                      {f.label}
                    </button>
                  );
                })}
              </div>
              <div style={{ position: 'relative', flex: '0 0 auto' }}>
                <i className="fa-solid fa-key" style={{ position: 'absolute', left: 11, top: 11, fontSize: 11, color: 'var(--gray-400)' }} />
                <input type="password" className="lrl-focus" placeholder="Admin secret" value={adminSecret} onChange={(e) => setAdminSecret(e.target.value)}
                  style={{ width: 190, border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--surface)', padding: '9px 12px 9px 30px', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-body)' }} />
              </div>
            </div>

            {(saveMsg || saveErr) && (
              <div style={{ marginBottom: 12, fontSize: 13, fontWeight: 600, color: saveErr ? '#b42318' : 'var(--teal-700)' }}>
                <i className={`fa-solid ${saveErr ? 'fa-circle-exclamation' : 'fa-circle-check'}`} style={{ marginRight: 7 }} />
                {saveErr || saveMsg}
              </div>
            )}

            <MappingTable rows={rows} catalogs={catalogs} disabled={saving} filter={{ query, status }} onChange={onRowsChange} />
          </>
        )}
      </div>
    </AppShell>
  );
}
