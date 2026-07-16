// pages/mappings/[id].tsx — the connection editor. Dispatches by id:
//   'new'                     → NewConnection chooser (association-driven)
//   <uuid>                    → GHL→Wix editor (a Wix set)
//   any other slug            → GHL↔GHL editor (contact-company or a created pair)

import { useRouter } from 'next/router';
import Shell from '@/components/shell/Shell';
import GhlConnectionEditor from '@/components/mapping/GhlConnectionEditor';
import WixConnectionEditor from '@/components/mapping/WixConnectionEditor';
import NewConnection from '@/components/mapping/NewConnection';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function ConnectionDetail() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : '';

  let body: React.ReactNode = <div style={{ fontSize: 14, color: 'var(--gray-500)' }}>Loading…</div>;
  if (id === 'new') body = <NewConnection />;
  else if (UUID.test(id)) body = <WixConnectionEditor id={id} />;
  else if (id) body = <GhlConnectionEditor slug={id} />;

  return (
    <Shell active="mappings" breadcrumb="Field Mappings" env="live">
      <div style={{ padding: '22px 30px', maxWidth: 1180, margin: '0 auto' }}>
        <a href="/mappings" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600, color: 'var(--gray-500)', textDecoration: 'none', marginBottom: 16 }}>
          <i className="fa-solid fa-chevron-left" style={{ fontSize: 11 }} /> All mappings
        </a>
        {body}
      </div>
    </Shell>
  );
}
