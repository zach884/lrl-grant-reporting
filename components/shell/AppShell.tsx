// components/shell/AppShell.tsx — Sync Engine app shell (dark ink sidebar + header).
//
// Synthesized from the LRL design handoff (option 1a chrome). One dark rail with the module
// nav; Field Mappings is the only live module today, the rest are flagged "Soon" so the shell
// already accommodates Data Enrichment / Activity Reporting / Grant Reporting.

import type { ReactNode } from 'react';

interface ModuleItem {
  id: string;
  label: string;
  icon: string; // Font Awesome solid glyph, e.g. "fa-gauge-high"
  href?: string;
  soon?: boolean;
}

const MODULES: ModuleItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'fa-gauge-high', soon: true },
  { id: 'mappings', label: 'Field Mappings', icon: 'fa-arrow-right-arrow-left', href: '/mappings' },
  { id: 'enrichment', label: 'Data Enrichment', icon: 'fa-wand-magic-sparkles', href: '/enrichment' },
  { id: 'activity', label: 'Activity Reporting', icon: 'fa-clipboard-list', soon: true },
  { id: 'grants', label: 'Grant Reporting', icon: 'fa-file-invoice-dollar', soon: true },
  { id: 'settings', label: 'Settings', icon: 'fa-gear', soon: true },
];

export default function AppShell({
  active,
  breadcrumb,
  env = 'live',
  children,
}: {
  active: string;
  breadcrumb: string;
  env?: 'live' | 'sandbox';
  children: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-body)', overflow: 'hidden' }}>
      {/* ---- Sidebar (dark ink rail) ---- */}
      <aside style={{ width: 248, flex: 'none', background: 'var(--ink-900)', position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <i className="fa-solid fa-rocket" style={{ position: 'absolute', right: -30, bottom: -46, fontSize: 280, color: 'var(--yellow-500)', opacity: 0.05, transform: 'rotate(-12deg)', pointerEvents: 'none' }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '22px 20px 18px', position: 'relative' }}>
          <span style={{ width: 36, height: 36, borderRadius: 9, background: 'var(--brand)', color: 'var(--ink-900)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17 }}>
            <i className="fa-solid fa-rocket" />
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 14, letterSpacing: '.02em', color: '#fff' }}>LEAN ROCKET</span>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 10, letterSpacing: '.22em', color: 'var(--yellow-500)' }}>SYNC ENGINE</span>
          </span>
        </div>

        <div style={{ height: 1, background: 'var(--ink-700)', margin: '2px 16px 10px' }} />

        <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, position: 'relative', padding: '0 0 0 0' }}>
          {MODULES.map((m) => {
            const isActive = m.id === active;
            const clickable = !!m.href && !m.soon;
            const inner = (
              <div
                style={{
                  display: 'flex', alignItems: 'center', gap: 13, padding: '11px 20px',
                  fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 14,
                  cursor: clickable ? 'pointer' : 'default',
                  borderLeft: '3px solid transparent',
                  color: isActive ? '#fff' : m.soon ? 'var(--gray-400)' : 'var(--gray-300)',
                  background: isActive ? 'color-mix(in srgb, var(--brand) 15%, transparent)' : 'transparent',
                  borderLeftColor: isActive ? 'var(--brand)' : 'transparent',
                }}
              >
                <i className={`fa-solid ${m.icon}`} style={{ width: 20, textAlign: 'center', fontSize: 15 }} />
                <span style={{ flex: 1 }}>{m.label}</span>
                {m.soon && (
                  <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 8.5, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--gray-450)', border: '1px solid var(--ink-700)', borderRadius: 999, padding: '2px 6px' }}>Soon</span>
                )}
              </div>
            );
            return clickable ? (
              <a key={m.id} href={m.href} style={{ textDecoration: 'none' }}>{inner}</a>
            ) : (
              <div key={m.id} title={m.soon ? 'Coming soon' : undefined}>{inner}</div>
            );
          })}
        </nav>

        <div style={{ marginTop: 'auto', padding: 16, position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--ink-800)', borderRadius: 10 }}>
            <span style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--teal-500)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12 }}>LR</span>
            <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>LRL Admin</span>
              <span style={{ fontSize: 11, color: 'var(--gray-400)' }}>Lean Rocket Lab</span>
            </span>
          </div>
        </div>
      </aside>

      {/* ---- Main column ---- */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <header style={{ height: 62, flex: 'none', background: 'var(--surface)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 26px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--gray-500)' }}>
            <i className="fa-solid fa-arrow-right-arrow-left" style={{ color: 'var(--gray-400)' }} />
            <span>Sync</span>
            <span style={{ color: 'var(--gray-300)' }}>/</span>
            <span style={{ color: 'var(--text)', fontWeight: 700, fontFamily: 'var(--font-display)' }}>{breadcrumb}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 600, color: 'var(--gray-500)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--teal-500)', boxShadow: '0 0 0 3px var(--accent-tint)' }} />
              GHL connected
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10, letterSpacing: '.14em', textTransform: 'uppercase',
              color: env === 'live' ? 'var(--teal-700)' : 'var(--yellow-700)',
              background: env === 'live' ? 'var(--accent-tint)' : 'var(--brand-tint)',
              padding: '5px 10px', borderRadius: 999 }}>
              <i className={`fa-solid ${env === 'live' ? 'fa-circle-check' : 'fa-flask'}`} style={{ fontSize: 9 }} />
              {env === 'live' ? 'Live' : 'Sandbox'}
            </span>
            <span style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--ink-900)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13 }}>LR</span>
          </div>
        </header>

        <main style={{ flex: 1, overflow: 'auto', background: 'var(--bg)' }}>{children}</main>
      </div>
    </div>
  );
}
