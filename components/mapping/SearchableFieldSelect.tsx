// components/mapping/SearchableFieldSelect.tsx — a click-to-open, type-to-filter field picker.
//
// Shared by the GHL contact<->company mapper and the GHL->Wix mapper. Results stay grouped by
// folder in the API's order; typing filters by name or key; Enter picks the top match; Esc /
// click-away closes. The menu is position:fixed (anchored to the trigger) so an ancestor's
// overflow:hidden can't clip it.

import { useEffect, useMemo, useRef, useState } from 'react';

export interface CatalogFieldOpt {
  fieldKey: string;
  name: string;
  dataType: string;
  folder?: string | null;
}

const selectBase: React.CSSProperties = {
  width: '100%', borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--surface)',
  padding: '7px 9px', fontSize: 13, fontFamily: 'var(--font-body)', color: 'var(--text)', cursor: 'pointer',
};

function optRowStyle(active: boolean): React.CSSProperties {
  return {
    display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
    padding: '7px 14px', fontSize: 12.5, fontFamily: 'var(--font-body)',
    background: active ? 'var(--accent-tint)' : 'transparent',
    color: active ? 'var(--teal-700)' : 'var(--text)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  };
}

export default function SearchableFieldSelect({ scalars, fields, value, onChange, disabled, tone, placeholder }: {
  scalars: string[]; fields: CatalogFieldOpt[]; value: string;
  onChange: (v: string) => void; disabled?: boolean; tone?: 'mono'; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const byKey = useMemo(() => {
    const m = new Map<string, CatalogFieldOpt>();
    for (const f of fields) m.set(f.fieldKey, f);
    return m;
  }, [fields]);

  const cur = value ? byKey.get(value) : undefined;
  const currentLabel = value
    ? (cur ? `${cur.name} — ${value}` : scalars.includes(value) ? value : `${value} · not in catalog`)
    : '';

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const ok = (name: string, key: string) =>
      !needle || name.toLowerCase().includes(needle) || key.toLowerCase().includes(needle);
    const out: { folder: string; items: { key: string; label: string }[] }[] = [];
    const std = scalars.filter((s) => ok(s, s)).map((s) => ({ key: s, label: s }));
    if (std.length) out.push({ folder: 'Standard fields', items: std });
    const byFolder = new Map<string, { key: string; label: string }[]>();
    for (const f of fields) {
      if (!ok(f.name, f.fieldKey)) continue;
      const k = f.folder || 'Other';
      if (!byFolder.has(k)) byFolder.set(k, []);
      byFolder.get(k)!.push({ key: f.fieldKey, label: `${f.name} — ${f.fieldKey}` });
    }
    for (const [folder, items] of Array.from(byFolder.entries())) out.push({ folder, items });
    return out;
  }, [q, scalars, fields]);

  const firstMatch = groups[0]?.items[0]?.key;

  function openMenu() {
    if (disabled) return;
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) {
      const width = Math.max(r.width, 340);
      const left = Math.min(r.left, window.innerWidth - width - 10);
      setRect({ top: r.bottom + 4, left: Math.max(8, left), width });
    }
    setQ('');
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function pick(k: string) { onChange(k); setOpen(false); }

  const triggerStyle: React.CSSProperties = {
    ...selectBase,
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0,
    ...(tone === 'mono' ? { fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--teal-700)' } : {}),
    ...(disabled ? { cursor: 'default', opacity: 0.7 } : {}),
  };

  return (
    <>
      <button
        ref={triggerRef} type="button" className="lrl-focus" style={triggerStyle}
        disabled={disabled} onClick={() => (open ? setOpen(false) : openMenu())}
        title={currentLabel || placeholder || 'Choose a field'}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: currentLabel ? undefined : 'var(--gray-400)' }}>
          {currentLabel || placeholder || '— choose field —'}
        </span>
        <i className="fa-solid fa-chevron-down" style={{ fontSize: 10, color: 'var(--gray-400)', flex: 'none' }} />
      </button>

      {open && rect && (
        <div style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width, zIndex: 1000,
          background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 10, boxShadow: 'var(--shadow-md, 0 12px 32px rgba(0,0,0,.16))', overflow: 'hidden' }}>
          <div style={{ padding: 8, borderBottom: '1px solid var(--border)', position: 'relative' }}>
            <i className="fa-solid fa-magnifying-glass" style={{ position: 'absolute', left: 18, top: 18, fontSize: 11, color: 'var(--gray-400)' }} />
            <input
              autoFocus type="text" value={q} placeholder="Type to filter fields…"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && q.trim() && firstMatch) { e.preventDefault(); pick(firstMatch); } }}
              className="lrl-focus"
              style={{ width: '100%', border: '1px solid var(--border-strong)', borderRadius: 7, background: 'var(--surface-subtle)', padding: '8px 10px 8px 28px', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-body)' }}
            />
          </div>
          <div style={{ maxHeight: 320, overflowY: 'auto', padding: '4px 0' }}>
            {value && (
              <button type="button" onClick={() => pick('')}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-subtle)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                style={optRowStyle(false)}>
                <span style={{ color: 'var(--gray-400)' }}>— clear —</span>
              </button>
            )}
            {groups.length === 0 && (
              <div style={{ padding: '16px 14px', fontSize: 13, color: 'var(--gray-450)', textAlign: 'center' }}>No fields match “{q}”.</div>
            )}
            {groups.map((g) => (
              <div key={g.folder}>
                <div style={{ padding: '7px 14px 4px', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--gray-450)', position: 'sticky', top: 0, background: 'var(--surface)' }}>{g.folder}</div>
                {g.items.map((it) => {
                  const active = it.key === value;
                  return (
                    <button key={it.key} type="button" onClick={() => pick(it.key)}
                      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--surface-subtle)'; }}
                      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                      style={optRowStyle(active)}>
                      {it.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
