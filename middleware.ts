// middleware.ts — DEFAULT DENY for the whole app.
//
// WHY THIS EXISTS. Measured 2026-09-04, anonymously, from outside the network:
//   200 GET /api/companies/search   200 GET /api/mapping/list   200 GET /api/enrichers
// 7 of 49 API routes checked anything (the webhook receivers, via x-webhook-secret). The other 42
// were open — including /api/mapping/apply, which writes to live GHL. `lib/auth.ts` is not
// authentication: `parseGHLContext` reads `user_role` from the query string, so `?user_role=admin`
// was an admin. That was survivable while the URL was a staff secret. The client reporting funnel
// emails the URL to every client we have, which is what made this urgent.
//
// The rule is inverted from what it was: everything requires a staff session UNLESS it is on one of
// the two allowlists below.
//
// Runs on the EDGE runtime — no node:crypto, no GHL client, no Postgres. Verification is Web Crypto
// only (lib/security/hmac.ts).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { STAFF_COOKIE, verifyStaffSession } from './lib/security/staffSession';

/**
 * Routes that enforce their OWN auth and must pass through untouched.
 *
 * The webhook receivers are here rather than re-checked one layer up ON PURPOSE. They already verify
 * `x-webhook-secret`, they are live and load-bearing during reporting season, and two different
 * secret env vars are in play (SYNC_WEBHOOK_SECRET, WIX_SYNC_WEBHOOK_SECRET). Duplicating that check
 * here is how a webhook goes down at 2am for no security gain.
 */
const SELF_ENFORCING = [
  '/api/form-sync',
  '/api/sync/up',
  '/api/wix-sync',
  '/api/appointment-sync',
  '/api/opportunity-sync',
  '/api/resource-sync',
  '/api/readiness-tag',
  // Client-facing: verifies a signed client token (lib/security/clientToken.ts).
  '/api/client-profile',
];

/** Public surface: the client rescore page and the staff login itself. */
const PUBLIC_PREFIXES = ['/client-reporting', '/staff-login', '/api/staff/login'];

const isApi = (p: string) => p.startsWith('/api/');

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (SELF_ENFORCING.some((p) => pathname === p || pathname.startsWith(p + '/'))) return NextResponse.next();
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))) return NextResponse.next();

  const session = await verifyStaffSession(req.cookies.get(STAFF_COOKIE)?.value);
  if (session) return NextResponse.next();

  // An API caller gets a flat 401. Do not redirect an API route to a login page: fetch() follows the
  // redirect and the caller sees a 200 full of HTML, which is how "it silently returned nothing"
  // bugs are born.
  if (isApi(pathname)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = '/staff-login';
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

// Everything except Next's own static output and the fonts the app serves from /pages/fonts.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|fonts/).*)'],
};
