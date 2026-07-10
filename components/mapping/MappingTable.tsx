// components/mapping/MappingTable.tsx — the Field Mappings workspace table.
//
// Reskinned to the LRL design system (teal/yellow/ink, pills + switches, mono-teal
// destinations) while staying fully editable: source/destination/direction are styled
// selects, enable is a switch, notes + validation warnings render on a secondary line.
// Presentational — the parent owns row state and passes filter (query/status).

import { useMemo } from 'react';
import type { MappingIssue, SyncDirection } from '@/lib/mapping/types';

export interface CatalogFieldOpt {
  fieldKey: string;
  name: string;
  dataType: string;
  folder?: string | null;
}
export interface MapperCatalogs {
  contact: { scalars: string[]; fields: CatalogFieldOpt[] };
  business: { scalars: string[]; folders: { id: string; name: string }[]; fields: CatalogFieldOpt[] };
}
export interface EditableRow {
  contactKey: string;
  businessKey: string;
  direction: SyncDirection;
  mirrorDown: boolean;
  enabled?: boolean;
  note?: string;
  holdValues?: string[];
  transform?: 'countryCode';
  issues?: MappingIssue[];
}
export type StatusFilter = 'all' | 'active' | 'review' | 'off';

const GRID = 'minmax(0,1.5fr) 154px minmax(0,1.6fr) 108px 52px';

const selectBase: React.CSSProperties = {
  width: '100%', borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--surface)',
  padding: '7px 9px', fontSize: 13, fontFamily: 'var(--font-body)', color: 'var(--text)', cursor: 'pointer',
};

const DIR_META: Record<SyncDirection, { label: string; sym: string; bg: string; fg: string }> = {
  up: { label: 'Push up', sym: '→', bg: 'var(--brand-tint)', fg: 'var(--yellow-700)' },
  down: { label: 'Pull down', sym: '←', bg: 'var(--gray-150)', fg: 'var(--gray-500)' },
  both: { label: 'Two-way', sym: '⇄', bg: 'var(--accent-tint)', fg: 'var(--teal-700)' },
};

function rowStatus(r: EditableRow): { key: StatusFilter; label: string; bg: string; fg: string } {
  if (r.enabled === false) return { key: 'off', label: 'Off', bg: 'var(--gray-100)', fg: 'var(--gray-450)' };
  if (r.issues?.some((i) => i.level === 'error')) return { key: 'review', label: 'Error', bg: '#fde8e8', fg: '#b42318' };
  if (r.issues?.some((i) => i.level === 'warning')) return { key: 'review', label: 'Review', bg: 'var(--brand-tint)', fg: 'var(--yellow-700)' };
  return { key: 'active', label: 'Active', bg: 'var(--accent-tint)', fg: 'var(--teal-700)' };
}

function FieldOptions({ scalars, fields, current }: {
  scalars: string[]; fields: CatalogFieldOpt[]; current: string;
}) {
  const known = new Set<string>([...scalars, ...fields.map((f) => f.fieldKey)]);
  // Group by folder, preserving the API's order (already sorted to GHL's folder + field
  // display order). Map insertion order = GHL order — do NOT re-sort alphabetically.
  const groups = useMemo(() => {
    const byFolder = new Map<string, CatalogFieldOpt[]>();
    for (const f of fields) {
      const k = f.folder || 'Other';
      if (!byFolder.has(k)) byFolder.set(k, []);
      byFolder.get(k)!.push(f);
    }
    return Array.from(byFolder.entries());
  }, [fields]);

  return (
    <>
      <option value="">— choose field —</option>
      {current && !known.has(current) && <option value={current}>{current} (not in catalog)</option>}
      <optgroup label="Standard fields">
        {scalars.map((s) => <option key={s} value={s}>{s}</option>)}
      </optgroup>
      {groups.map(([folder, fs]) => (
        <optgroup key={folder} label={folder}>
          {fs.map((f) => <option key={f.fieldKey} value={f.fieldKey}>{f.name} — {f.fieldKey}</option>)}
        </optgroup>
      ))}
    </>
  );
}

function Switch({ on, disabled, onToggle }: { on: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} disabled={disabled} onClick={onToggle}
      className="lrl-focus"
      style={{
        width: 40, height: 23, borderRadius: 999, border: 'none', position: 'relative', cursor: disabled ? 'default' : 'pointer',
        background: on ? 'var(--teal-500)' : 'var(--gray-300)', transition: 'background .16s', flex: 'none', padding: 0,
      }}
      title={on ? 'Enabled — syncing' : 'Disabled — kept but not synced'}
    >
      <span style={{ position: 'absolute', top: 2, left: on ? 19 : 2, width: 19, height: 19, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.25)', transition: 'left .16s' }} />
    </button>
  );
}

export default function MappingTable({
  rows, catalogs, disabled, filter, onChange,
}: {
  rows: EditableRow[];
  catalogs: MapperCatalogs;
  disabled?: boolean;
  filter: { query: string; status: StatusFilter };
  onChange: (rows: EditableRow[]) => void;
}) {
  function update(i: number, patch: Partial<EditableRow>) {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function remove(i: number) { onChange(rows.filter((_, idx) => idx !== i)); }
  function add() { onChange([...rows, { contactKey: '', businessKey: '', direction: 'both', mirrorDown: false }]); }

  const q = filter.query.trim().toLowerCase();
  const visible = (r: EditableRow) => {
    if (filter.status !== 'all' && rowStatus(r).key !== filter.status) return false;
    if (!q) return true;
    return (r.contactKey + ' ' + r.businessKey + ' ' + (r.note ?? '')).toLowerCase().includes(q);
  };
  const shownCount = rows.filter(visible).length;

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
      {/* header row */}
      <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 12, padding: '12px 20px', background: 'var(--surface-subtle)', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10.5, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--gray-450)' }}>
        <span>Source field · Contact</span>
        <span style={{ textAlign: 'center' }}>Sync</span>
        <span>GHL destination · Company</span>
        <span>Status</span>
        <span style={{ textAlign: 'right' }}>On</span>
      </div>

      {rows.map((r, i) => {
        if (!visible(r)) return null;
        const st = rowStatus(r);
        const dir = DIR_META[r.direction];
        const dim = r.enabled === false ? 0.55 : 1;
        const hasDetail = !!(r.note || r.issues?.length);
        return (
          <div key={i} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)', padding: '11px 20px', opacity: dim }}>
            <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 12, alignItems: 'center' }}>
              {/* source */}
              <select className="lrl-focus" style={selectBase} disabled={disabled} value={r.contactKey} onChange={(e) => update(i, { contactKey: e.target.value })}>
                <FieldOptions scalars={catalogs.contact.scalars} fields={catalogs.contact.fields} current={r.contactKey} />
              </select>
              {/* direction (colored pill-select) */}
              <select
                className="lrl-focus"
                style={{ ...selectBase, textAlign: 'center', fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 12, background: dir.bg, color: dir.fg, border: '1px solid transparent' }}
                disabled={disabled} value={r.direction} onChange={(e) => update(i, { direction: e.target.value as SyncDirection })}
                title="Sync direction"
              >
                <option value="up">→ Push up</option>
                <option value="down">← Pull down</option>
                <option value="both">⇄ Two-way</option>
              </select>
              {/* destination */}
              <select className="lrl-focus" style={{ ...selectBase, fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--teal-700)' }} disabled={disabled} value={r.businessKey} onChange={(e) => update(i, { businessKey: e.target.value })}>
                <FieldOptions scalars={catalogs.business.scalars} fields={catalogs.business.fields} current={r.businessKey} />
              </select>
              {/* status */}
              <span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', padding: '4px 9px', borderRadius: 999, background: st.bg, color: st.fg }}>{st.label}</span>
              </span>
              {/* enable + remove */}
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                <Switch on={r.enabled !== false} disabled={disabled} onToggle={() => update(i, { enabled: r.enabled === false })} />
                <button type="button" onClick={() => remove(i)} disabled={disabled} title="Remove row" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gray-400)', fontSize: 13 }}>
                  <i className="fa-solid fa-xmark" />
                </button>
              </span>
            </div>

            {/* secondary line: note + warnings */}
            {hasDetail && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginTop: 8, paddingLeft: 2 }}>
                <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                  <i className="fa-solid fa-pen" style={{ position: 'absolute', left: 9, top: 9, fontSize: 10, color: 'var(--gray-400)' }} />
                  <input
                    type="text" className="lrl-focus" disabled={disabled} value={r.note ?? ''} placeholder="Add a note…"
                    onChange={(e) => update(i, { note: e.target.value })}
                    style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-subtle)', padding: '6px 9px 6px 26px', fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-body)' }}
                  />
                </div>
                {!!r.issues?.length && (
                  <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 3, maxWidth: '46%' }}>
                    {r.issues.map((x, j) => (
                      <li key={j} style={{ fontSize: 11.5, color: x.level === 'error' ? '#b42318' : 'var(--yellow-700)', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                        <i className={`fa-solid ${x.level === 'error' ? 'fa-circle-exclamation' : 'fa-triangle-exclamation'}`} style={{ marginTop: 2, fontSize: 10 }} />
                        <span>{x.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        );
      })}

      {shownCount === 0 && (
        <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--gray-450)', fontSize: 13, borderTop: '1px solid var(--border)' }}>
          {rows.length === 0 ? 'No mappings yet. Add a row or use “Auto-suggest”.' : 'No mappings match your search / filter.'}
        </div>
      )}

      {/* footer add affordance */}
      <div style={{ padding: '13px 20px', borderTop: '1px solid var(--border)', background: 'var(--surface-subtle)' }}>
        <button type="button" onClick={add} disabled={disabled} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: 'var(--teal-600)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-body)' }}>
          <i className="fa-solid fa-plus" /> Add field mapping
        </button>
      </div>
    </div>
  );
}
