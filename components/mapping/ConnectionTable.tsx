// components/mapping/ConnectionTable.tsx — the shared field-mapping table for any connection.
//
// Generalized from MappingTable so one table serves both GHL↔GHL (two-way, per-row direction)
// and GHL→Wix (one-way, locked "→ Push 🔒", with a per-row transform). Source/destination use
// the shared SearchableFieldSelect; the destination is tool-tinted (teal for GHL, violet Wix).

import { useMemo } from 'react';
import SearchableFieldSelect, { type CatalogFieldOpt } from './SearchableFieldSelect';
import type { MappingIssue } from '@/lib/mapping/types';

export type ConnDirection = 'up' | 'down' | 'both';
export type ConnStatusFilter = 'all' | 'active' | 'review' | 'off';

export interface ConnRow {
  sourceKey: string;
  targetKey: string;
  direction: ConnDirection;
  transform?: string;
  enabled?: boolean;
  note?: string;
  issues?: MappingIssue[];
  // Carried through for GHL↔GHL saves (not shown in the table) so nothing is dropped.
  mirrorDown?: boolean;
  holdValues?: string[];
}

export interface FieldOptions {
  scalars: string[];
  fields: CatalogFieldOpt[];
}

const TRANSFORMS = [
  { v: '', label: 'auto' },
  { v: 'html', label: 'html' },
  { v: 'imageFromUpload', label: 'image import' },
  { v: 'referenceFromOptions', label: 'reference' },
  { v: 'arrayFromMultiSelect', label: 'array' },
  { v: 'countryCode', label: 'country code' },
];

const GRID = 'minmax(0,1.5fr) 150px minmax(0,1.6fr) 108px 52px';

const selectBase: React.CSSProperties = {
  width: '100%', borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--surface)',
  padding: '7px 9px', fontSize: 13, fontFamily: 'var(--font-body)', color: 'var(--text)', cursor: 'pointer',
};

const DIR_META: Record<ConnDirection, { label: string; bg: string; fg: string }> = {
  up: { label: '→ Push up', bg: 'var(--brand-tint)', fg: 'var(--yellow-700)' },
  down: { label: '← Pull down', bg: 'var(--gray-150)', fg: 'var(--gray-500)' },
  both: { label: '⇄ Two-way', bg: 'var(--accent-tint)', fg: 'var(--teal-700)' },
};

function rowStatus(r: ConnRow): { key: ConnStatusFilter; label: string; bg: string; fg: string } {
  if (r.enabled === false) return { key: 'off', label: 'Off', bg: 'var(--gray-100)', fg: 'var(--gray-450)' };
  if (r.issues?.some((i) => i.level === 'error')) return { key: 'review', label: 'Error', bg: '#fde8e8', fg: '#b42318' };
  if (r.issues?.some((i) => i.level === 'warning')) return { key: 'review', label: 'Review', bg: 'var(--brand-tint)', fg: 'var(--yellow-700)' };
  return { key: 'active', label: 'Active', bg: 'var(--accent-tint)', fg: 'var(--teal-700)' };
}

function Switch({ on, disabled, onToggle }: { on: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={onToggle} className="lrl-focus"
      style={{ width: 40, height: 23, borderRadius: 999, border: 'none', position: 'relative', cursor: disabled ? 'default' : 'pointer',
        background: on ? 'var(--teal-500)' : 'var(--gray-300)', transition: 'background .16s', flex: 'none', padding: 0 }}
      title={on ? 'Enabled — syncing' : 'Disabled — kept but not synced'}>
      <span style={{ position: 'absolute', top: 2, left: on ? 19 : 2, width: 19, height: 19, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.25)', transition: 'left .16s' }} />
    </button>
  );
}

export default function ConnectionTable({
  rows, source, target, oneWay, showTransform, destTone = 'teal', sourceLabel, targetLabel, disabled, filter, onChange,
}: {
  rows: ConnRow[];
  source: FieldOptions;
  target: FieldOptions;
  oneWay: boolean;
  showTransform?: boolean;
  destTone?: 'teal' | 'violet';
  sourceLabel: string;
  targetLabel: string;
  disabled?: boolean;
  filter: { query: string; status: ConnStatusFilter };
  onChange: (rows: ConnRow[]) => void;
}) {
  function update(i: number, patch: Partial<ConnRow>) { onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r))); }
  function remove(i: number) { onChange(rows.filter((_, idx) => idx !== i)); }
  function add() { onChange([...rows, { sourceKey: '', targetKey: '', direction: oneWay ? 'up' : 'both' }]); }

  const q = filter.query.trim().toLowerCase();
  const visible = (r: ConnRow) => {
    if (filter.status !== 'all' && rowStatus(r).key !== filter.status) return false;
    if (!q) return true;
    return (r.sourceKey + ' ' + r.targetKey + ' ' + (r.note ?? '')).toLowerCase().includes(q);
  };
  const shownCount = useMemo(() => rows.filter(visible).length, [rows, q, filter.status]); // eslint-disable-line
  const destColor = destTone === 'violet' ? 'var(--violet-700)' : 'var(--teal-700)';

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 12, padding: '12px 20px', background: 'var(--surface-subtle)', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10.5, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--gray-450)' }}>
        <span>{sourceLabel}</span>
        <span style={{ textAlign: 'center' }}>Sync</span>
        <span>{targetLabel}</span>
        <span>Status</span>
        <span style={{ textAlign: 'right' }}>On</span>
      </div>

      {rows.map((r, i) => {
        if (!visible(r)) return null;
        const st = rowStatus(r);
        const dim = r.enabled === false ? 0.55 : 1;
        const dir = DIR_META[r.direction];
        const hasDetail = !!(r.note || r.issues?.length || showTransform);
        return (
          <div key={i} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)', padding: '11px 20px', opacity: dim }}>
            <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 12, alignItems: 'center' }}>
              <SearchableFieldSelect scalars={source.scalars} fields={source.fields} value={r.sourceKey} disabled={disabled} onChange={(v) => update(i, { sourceKey: v })} />

              {oneWay ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 12, background: 'var(--brand-tint)', color: 'var(--yellow-700)', borderRadius: 8, padding: '7px 9px' }} title="One-way — pushes to the destination">
                  → Push <i className="fa-solid fa-lock" style={{ fontSize: 9 }} />
                </span>
              ) : (
                <select className="lrl-focus" style={{ ...selectBase, textAlign: 'center', fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 12, background: dir.bg, color: dir.fg, border: '1px solid transparent' }}
                  disabled={disabled} value={r.direction} onChange={(e) => update(i, { direction: e.target.value as ConnDirection })} title="Sync direction">
                  <option value="up">→ Push up</option>
                  <option value="down">← Pull down</option>
                  <option value="both">⇄ Two-way</option>
                </select>
              )}

              <SearchableFieldSelect scalars={target.scalars} fields={target.fields} value={r.targetKey} disabled={disabled} tone="mono" onChange={(v) => update(i, { targetKey: v })} />

              <span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', padding: '4px 9px', borderRadius: 999, background: st.bg, color: st.fg }}>{st.label}</span>
              </span>

              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                <Switch on={r.enabled !== false} disabled={disabled} onToggle={() => update(i, { enabled: r.enabled === false })} />
                <button type="button" onClick={() => remove(i)} disabled={disabled} title="Remove row" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gray-400)', fontSize: 13 }}>
                  <i className="fa-solid fa-xmark" />
                </button>
              </span>
            </div>

            {hasDetail && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, paddingLeft: 2 }}>
                {showTransform && (
                  <select className="lrl-focus" value={r.transform ?? ''} disabled={disabled} onChange={(e) => update(i, { transform: e.target.value || undefined })}
                    style={{ ...selectBase, width: 150, flex: 'none', fontSize: 12, color: destColor }} title="Value transform">
                    {TRANSFORMS.map((t) => <option key={t.v} value={t.v}>transform: {t.label}</option>)}
                  </select>
                )}
                <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                  <i className="fa-solid fa-pen" style={{ position: 'absolute', left: 9, top: 9, fontSize: 10, color: 'var(--gray-400)' }} />
                  <input type="text" className="lrl-focus" disabled={disabled} value={r.note ?? ''} placeholder="Add a note…" onChange={(e) => update(i, { note: e.target.value })}
                    style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-subtle)', padding: '6px 9px 6px 26px', fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-body)' }} />
                </div>
                {!!r.issues?.length && (
                  <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 3, maxWidth: '40%' }}>
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
          {rows.length === 0 ? 'No mappings yet. Add a row.' : 'No mappings match your search / filter.'}
        </div>
      )}

      <div style={{ padding: '13px 20px', borderTop: '1px solid var(--border)', background: 'var(--surface-subtle)' }}>
        <button type="button" onClick={add} disabled={disabled} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: 'var(--teal-600)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-body)' }}>
          <i className="fa-solid fa-plus" /> Add field mapping
        </button>
      </div>
    </div>
  );
}
