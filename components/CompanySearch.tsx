// components/CompanySearch.tsx — company type-ahead. Company first, because reporting aggregates
// by company and an activity without one is invisible to every funder report.

import { useEffect, useRef, useState } from 'react';

export interface CompanyOption {
  id: string;
  name: string;
}

const input: React.CSSProperties = {
  width: '100%', border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--surface)',
  padding: '9px 11px', fontSize: 14, color: 'var(--text)', fontFamily: 'var(--font-body)',
};

export default function CompanySearch({
  value,
  onChange,
}: {
  value: CompanyOption | null;
  onChange: (c: CompanyOption | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CompanyOption[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/companies/search?q=${encodeURIComponent(query.trim())}`);
        const data = await res.json();
        setResults(data.companies ?? []);
        setOpen(true);
      } finally {
        setLoading(false);
      }
    }, 220);
    return () => clearTimeout(timer.current);
  }, [query]);

  if (value) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ ...input, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ fontWeight: 600 }}>{value.name}</span>
          <button
            type="button"
            onClick={() => { onChange(null); setQuery(''); }}
            style={{ border: 0, background: 'none', color: 'var(--gray-500)', cursor: 'pointer', fontSize: 13 }}
          >
            change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={wrap} style={{ position: 'relative' }}>
      <input
        style={input}
        value={query}
        placeholder="Search companies…"
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        autoComplete="off"
      />
      {open && (
        <div style={{
          position: 'absolute', zIndex: 20, top: '100%', left: 0, right: 0, marginTop: 4, maxHeight: 260,
          overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
          boxShadow: 'var(--shadow-sm)',
        }}>
          {loading && <div style={{ padding: '9px 12px', fontSize: 13, color: 'var(--gray-500)' }}>Searching…</div>}
          {!loading && results.length === 0 && (
            <div style={{ padding: '9px 12px', fontSize: 13, color: 'var(--gray-500)' }}>No companies match “{query}”.</div>
          )}
          {results.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => { onChange(c); setOpen(false); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', fontSize: 14,
                border: 0, background: 'none', cursor: 'pointer', color: 'var(--text)',
              }}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
