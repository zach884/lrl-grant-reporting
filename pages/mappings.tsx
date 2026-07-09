// pages/mappings.tsx — visual field-mapping builder (v1: the contact⇄company sync).
//
// Loads the sync's rows (annotated against live catalogs) + the field catalogs, lets an
// admin edit the spreadsheet-style grid, auto-suggest pairings, and save. Saving requires
// the admin secret (held in sessionStorage) and takes effect immediately — no redeploy.

import { useCallback, useEffect, useState } from 'react';
import MappingTable, { type EditableRow, type MapperCatalogs } from '@/components/mapping/MappingTable';
import type { MappingIssue, ResolvedFieldMapping, FieldMapping } from '@/lib/mapping/types';

const SLUG = 'contact-company';
const SECRET_KEY = 'mapping_admin_secret';

function toRow(m: ResolvedFieldMapping): EditableRow {
  return {
    contactKey: m.contactKey,
    businessKey: m.businessKey,
    direction: m.direction,
    mirrorDown: m.mirrorDown,
    enabled: m.enabled,
    note: m.note,
    holdValues: m.holdValues,
    transform: m.transform,
    issues: m.issues,
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

export default function MappingsPage() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [catalogs, setCatalogs] = useState<MapperCatalogs | null>(null);
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [issues, setIssues] = useState<MappingIssue[]>([]);
  const [version, setVersion] = useState<number>(0);
  const [updatedAt, setUpdatedAt] = useState<string>('');
  const [dirty, setDirty] = useState(false);

  const [adminSecret, setAdminSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [saveErr, setSaveErr] = useState('');

  useEffect(() => {
    setAdminSecret(sessionStorage.getItem(SECRET_KEY) ?? '');
  }, []);

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
    setRows(next);
    setDirty(true);
    setSaveMsg('');
    setSaveErr('');
  }

  async function autoSuggest() {
    setSaveErr('');
    try {
      const res = await fetch(`/api/mapping/${SLUG}/suggest`);
      if (!res.ok) throw new Error((await res.json()).error ?? 'suggest failed');
      const { suggestions } = (await res.json()) as { suggestions: FieldMapping[] };
      const have = new Set(rows.map((r) => `${r.contactKey}→${r.businessKey}`));
      const additions = suggestions
        .filter((s) => !have.has(`${s.contactKey}→${s.businessKey}`))
        .map((s) => ({ ...s } as EditableRow));
      if (!additions.length) {
        setSaveMsg('No new suggestions — all suggested pairs are already present.');
        return;
      }
      setRows([...rows, ...additions]);
      setDirty(true);
      setSaveMsg(`Added ${additions.length} suggested row(s). Review, then Save.`);
    } catch (e: any) {
      setSaveErr(e?.message ?? 'suggest failed');
    }
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
      await loadSync(); // refresh annotations/issues + version
      setSaveMsg(`Saved v${data.version} · ${data.count} mappings · live now (no redeploy).`);
    } catch (e: any) {
      setSaveErr(e?.message ?? 'save failed');
    } finally {
      setSaving(false);
    }
  }

  const errorCount = issues.filter((i) => i.level === 'error').length;
  const warnCount = issues.filter((i) => i.level === 'warning').length;

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Field Mappings</h1>
          <p className="text-sm text-gray-500">
            Contact ⇄ Company sync
            {version ? <> · v{version}{updatedAt ? ` · updated ${new Date(updatedAt).toLocaleString()}` : ''}</> : null}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={autoSuggest}
            disabled={loading || saving}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            Auto-suggest
          </button>
          <button
            type="button"
            onClick={save}
            disabled={loading || saving || !dirty}
            className="rounded bg-[#f8b932] px-4 py-1.5 text-sm font-medium text-black hover:brightness-95 disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {loading && <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">Loading…</div>}
      {loadError && <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{loadError}</div>}

      {!loading && !loadError && catalogs && (
        <div className="space-y-4">
          {(errorCount > 0 || warnCount > 0) && (
            <div className={`rounded-lg border p-3 text-sm ${errorCount ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
              {errorCount > 0 && <span className="font-medium">{errorCount} error(s)</span>}
              {errorCount > 0 && warnCount > 0 && ' · '}
              {warnCount > 0 && <span>{warnCount} warning(s)</span>} across mappings — see the flagged rows below.
            </div>
          )}

          <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            <MappingTable rows={rows} catalogs={catalogs} disabled={saving} onChange={onRowsChange} />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="password"
              placeholder="Admin secret (required to save)"
              value={adminSecret}
              onChange={(e) => setAdminSecret(e.target.value)}
              className="w-72 rounded border border-gray-300 px-2 py-1 text-sm focus:border-[#f8b932] focus:outline-none focus:ring-1 focus:ring-[#f8b932]"
            />
            {saveMsg && <span className="text-sm text-green-700">{saveMsg}</span>}
            {saveErr && <span className="text-sm text-red-600">{saveErr}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
