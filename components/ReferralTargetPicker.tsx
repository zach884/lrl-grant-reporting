// components/ReferralTargetPicker.tsx — "who was this client referred to?"
//
// Searches the Resources directory, contacts and companies at once, and ALSO accepts free text:
// not every counterparty is in the CRM, and a referral to someone who isn't is still worth logging.
// A picked target records its id and kind so the referral is traceable; free text records the name
// alone, which is what the funder reports actually count.

import { useEffect, useRef, useState } from 'react';

export type TargetKind = 'Resource' | 'Company' | 'Contact' | 'External';

export interface ReferralTarget {
  kind: TargetKind;
  id?: string;
  name: string;
  subtitle?: string;
}

const input: React.CSSProperties = {
  width: '100%', border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--surface)',
  padding: '9px 11px', fontSize: 14, color: 'var(--text)', fontFamily: 'var(--font-body)',
};

const KIND_TONE: Record<string, { bg: string; fg: string }> = {
  Resource: { bg: 'var(--accent-tint, #e6f4f1)', fg: 'var(--teal-700, #0f766e)' },
  Contact: { bg: 'var(--violet-100, #ece9fd)', fg: 'var(--violet-700, #5b21b6)' },
  Company: { bg: 'var(--brand-tint, #fdf3dd)', fg: 'var(--yellow-700, #b8860b)' },
  External: { bg: 'var(--gray-150, #eceef1)', fg: 'var(--gray-500)' },
};

function Tag({ kind }: { kind: TargetKind }) {
  const tone = KIND_TONE[kind] ?? KIND_TONE.External;
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase',
      background: tone.bg, color: tone.fg, borderRadius: 999, padding: '2px 7px', flexShrink: 0,
    }}>
      {kind}
    </span>
  );
}

export default function ReferralTargetPicker({
  value,
  onChange,
}: {
  value: ReferralTarget | null;
  onChange: (t: ReferralTarget | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ReferralTarget[]>([]);
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
    if (query.trim().length < 2) { setResults([]); return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/referral-targets/search?q=${encodeURIComponent(query.trim())}`);
        const data = await res.json();
        setResults(data.targets ?? []);
        setOpen(true);
      } finally {
        setLoading(false);
      }
    }, 220);
    return () => clearTimeout(timer.current);
  }, [query]);

  if (value) {
    return (
      <div style={{ ...input, display: 'flex', alignItems: 'center', gap: 9 }}>
        <Tag kind={value.kind} />
        <span style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {value.name}
        </span>
        <button
          type="button"
          onClick={() => { onChange(null); setQuery(''); }}
          style={{ border: 0, background: 'none', color: 'var(--gray-500)', cursor: 'pointer', fontSize: 13 }}
        >
          change
        </button>
      </div>
    );
  }

  const typed = query.trim();
  return (
    <div ref={wrap} style={{ position: 'relative' }}>
      <input
        style={input}
        value={query}
        placeholder="Search resources, contacts, companies — or type a name"
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        autoComplete="off"
      />
      {open && typed.length >= 2 && (
        <div style={{
          position: 'absolute', zIndex: 20, top: '100%', left: 0, right: 0, marginTop: 4, maxHeight: 300,
          overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
          boxShadow: 'var(--shadow-sm)',
        }}>
          {loading && <div style={{ padding: '9px 12px', fontSize: 13, color: 'var(--gray-500)' }}>Searching…</div>}
          {results.map((t) => (
            <button
              key={`${t.kind}:${t.id}`}
              type="button"
              onClick={() => { onChange(t); setOpen(false); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
                padding: '8px 12px', fontSize: 14, border: 0, background: 'none', cursor: 'pointer', color: 'var(--text)',
              }}
            >
              <Tag kind={t.kind} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.name}
                {t.subtitle && <span style={{ color: 'var(--gray-500)', fontSize: 12 }}> · {t.subtitle}</span>}
              </span>
            </button>
          ))}
          {/* Always offered: a counterparty that isn't in the CRM is still a real referral. */}
          <button
            type="button"
            onClick={() => { onChange({ kind: 'External', name: typed }); setOpen(false); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
              padding: '8px 12px', fontSize: 14, border: 0, borderTop: results.length ? '1px solid var(--border)' : 0,
              background: 'none', cursor: 'pointer', color: 'var(--text)',
            }}
          >
            <Tag kind="External" />
            <span>Use “{typed}” as a name</span>
          </button>
        </div>
      )}
    </div>
  );
}
