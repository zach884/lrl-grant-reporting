// components/shell/EmbeddedShell.tsx — lean shell for GHL iframe embedding.
//
// When the app runs as a GHL custom menu item, GHL supplies the outer sidebar, account bar,
// and LRL branding — so this shell repeats NONE of that chrome. It renders only a horizontal
// module tab bar + a scrolling body. No logo/rocket, breadcrumb, "GHL connected" status,
// Live/Sandbox pill, or avatar. Same public props as AppShell (env/breadcrumb are ignored).
// Tabs carry ?embed=1 so navigation inside the iframe stays embedded.

import type { ReactNode } from 'react';
import { MODULES } from '@/lib/nav/modules';

const EMBED_QS = '?embed=1';

export default function EmbeddedShell({
  active,
  children,
}: {
  active: string;
  breadcrumb?: string;
  env?: 'live' | 'sandbox';
  children: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-body)', overflow: 'hidden' }}>
      {/* module tab bar */}
      <nav
        style={{
          height: 60, flex: 'none', background: 'var(--surface)', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'stretch', gap: 4, padding: '0 20px', overflowX: 'auto', flexWrap: 'nowrap',
        }}
      >
        {MODULES.map((m) => {
          const isActive = m.id === active;
          const clickable = !!m.href && !m.soon;
          const color = isActive ? 'var(--text)' : m.soon ? 'var(--gray-400)' : 'var(--gray-500)';

          const inner = (
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 9, height: '100%', padding: '0 12px',
                fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap',
                color, cursor: clickable ? 'pointer' : 'default',
                borderBottom: `2px solid ${isActive ? 'var(--brand)' : 'transparent'}`,
              }}
            >
              <i className={`fa-solid ${m.icon}`} style={{ fontSize: 13, opacity: 0.85 }} />
              <span>{m.label}</span>
              {m.soon && (
                <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 8, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--gray-450)', border: '1px solid var(--border-strong)', borderRadius: 999, padding: '2px 6px' }}>Soon</span>
              )}
            </span>
          );

          return clickable ? (
            <a
              key={m.id}
              href={m.href + EMBED_QS}
              className="lrl-focus"
              style={{ textDecoration: 'none', display: 'flex' }}
              onMouseEnter={(e) => { if (!isActive) (e.currentTarget.firstChild as HTMLElement).style.color = 'var(--text)'; }}
              onMouseLeave={(e) => { if (!isActive) (e.currentTarget.firstChild as HTMLElement).style.color = 'var(--gray-500)'; }}
            >
              {inner}
            </a>
          ) : (
            <div key={m.id} title={m.soon ? 'Coming soon' : undefined} style={{ display: 'flex' }}>{inner}</div>
          );
        })}
      </nav>

      {/* body — page renders its own header/title, unchanged */}
      <main style={{ flex: 1, overflow: 'auto', background: 'var(--bg)' }}>{children}</main>
    </div>
  );
}
