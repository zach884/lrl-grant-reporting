// lib/auth/admin.ts — shared-secret guard for the mapping editor's write endpoints.
//
// The app sits behind Vercel Deployment Protection; this adds a second, app-level check so
// only holders of ADMIN_SECRET can mutate mappings. Mirrors the webhook's x-webhook-secret
// pattern in pages/api/sync/up.ts. Compared with a constant-time check to avoid leaking
// length/prefix via timing.

import { timingSafeEqual } from 'node:crypto';
import type { NextApiRequest } from 'next';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Returns true if the request carries the correct admin secret
 *  (header `x-admin-secret` or `?adminSecret=`). */
export function isAdmin(req: NextApiRequest): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false; // fail closed if unconfigured
  const provided =
    (req.headers['x-admin-secret'] as string) || (req.query.adminSecret as string) || '';
  return provided.length > 0 && safeEqual(provided, secret);
}
