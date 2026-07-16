// pages/wix-sync.tsx — retired. Website Sync folded into Field Mappings; redirect to the hub.

import type { GetServerSideProps } from 'next';

export const getServerSideProps: GetServerSideProps = async () => ({
  redirect: { destination: '/mappings', permanent: false },
});

export default function WixSyncRedirect() {
  return null;
}
