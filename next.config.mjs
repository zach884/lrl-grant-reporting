/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Correctness is gated by `tsc --noEmit` + the vitest suite (see package.json).
  // ESLint (next/typescript) flags intentional `any`s in the thin GHL API wrappers;
  // don't let those style rules block production builds. `npm run lint` still reports them.
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Allow GHL to iframe the app (embedded custom menu item). We set ONLY the
  // `frame-ancestors` CSP directive (not a full CSP, which could break the app) and never
  // send X-Frame-Options: DENY. Add LRL's white-label GHL domain to the list if the embed
  // is served under a custom domain.
  async headers() {
    const frameAncestors = [
      "'self'",
      'https://*.gohighlevel.com',
      'https://*.leadconnectorhq.com',
      'https://*.msgsndr.com',
      // LRL white-label GHL domain (the account is served from here).
      'https://app.leanrocketlab.org',
      'https://*.leanrocketlab.org',
    ].join(' ');
    return [
      {
        source: '/:path*',
        headers: [{ key: 'Content-Security-Policy', value: `frame-ancestors ${frameAncestors};` }],
      },
    ];
  },
};

export default nextConfig;
