// pages/mappings/[id].tsx — the connection editor. Picks the right editor by id:
//   'contact-company'  → GHL↔GHL editor (two-way)
//   'new' | <set uuid> → GHL→Wix editor (one-way)
// Both render inside a Back-to-hub frame.

import { useRouter } from 'next/router';
import Shell from '@/components/shell/Shell';
import GhlConnectionEditor from '@/components/mapping/GhlConnectionEditor';
import WixConnectionEditor from '@/components/mapping/WixConnectionEditor';

export default function ConnectionDetail() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : '';

  return (
    <Shell active="mappings" breadcrumb="Field Mappings" env="live">
      <div style={{ padding: '22px 30px', maxWidth: 1180, margin: '0 auto' }}>
        <a href="/mappings" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600, color: 'var(--gray-500)', textDecoration: 'none', marginBottom: 16 }}>
          <i className="fa-solid fa-chevron-left" style={{ fontSize: 11 }} /> All mappings
        </a>
        {!id ? (
          <div style={{ fontSize: 14, color: 'var(--gray-500)' }}>Loading…</div>
        ) : id === 'contact-company' ? (
          <GhlConnectionEditor />
        ) : (
          <WixConnectionEditor id={id} />
        )}
      </div>
    </Shell>
  );
}
