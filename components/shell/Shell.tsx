// components/shell/Shell.tsx — pick the shell based on how the app is being viewed.
//
// Embedded (lean tab-bar) shell vs standalone (dark rail) AppShell. We render embedded when
// EITHER the URL carries ?embed=1 OR the app is running inside an iframe (i.e. GHL is framing
// it) — so it "just works" inside GHL without needing the menu-item URL to include the param.
// Opened directly in a browser (not framed, no param) -> the full AppShell.
//
// Detected after mount (not useRouter().query, which stays empty until router.isReady on
// statically-optimized pages). Rendering AppShell on the server + first client paint, then
// switching in an effect, avoids an SSR hydration mismatch.

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
      const param = new URLSearchParams(window.location.search).get('embed') === '1';
      const framed = window.self !== window.top; // true when GHL iframes the app
      setEmbed(param || framed);
    } catch {
      // Accessing window.top can throw in a cross-origin frame -> we're embedded.
      setEmbed(true);
    }
  }, []);
  const S = embed ? EmbeddedShell : AppShell;
  return <S {...props} />;
}
