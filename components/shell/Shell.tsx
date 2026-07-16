// components/shell/Shell.tsx — pick the shell based on how the app is being viewed.
//
// GHL menu-item URLs carry ?embed=1 -> render the lean EmbeddedShell (tab bar, no chrome).
// Everything else -> the standalone AppShell (dark rail). Pages wrap their body in <Shell>
// and never care which one is active; EmbeddedShell's tab hrefs keep ?embed=1 across nav.
//
// We read the flag from the URL after mount (not useRouter().query, which stays empty until
// router.isReady on statically-optimized pages). Rendering AppShell on the server + first
// client paint, then switching in an effect, avoids an SSR hydration mismatch.

import { useEffect, useState, type ReactNode } from 'react';
import AppShell from './AppShell';
import EmbeddedShell from './EmbeddedShell';

export default function Shell(props: {
  active: string;
  breadcrumb: string;
  env?: 'live' | 'sandbox';
  children: ReactNode;
}) {
  const [embed, setEmbed] = useState(false);
  useEffect(() => {
    try {
      setEmbed(new URLSearchParams(window.location.search).get('embed') === '1');
    } catch { /* ignore */ }
  }, []);
  const S = embed ? EmbeddedShell : AppShell;
  return <S {...props} />;
}
