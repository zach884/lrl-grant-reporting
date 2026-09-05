// pages/api/staff/login.ts — exchange the shared staff password for a signed session cookie.
//
// Interim staff auth; see lib/security/staffSession.ts for why this is a shared credential and what
// replaces it. Allowlisted in middleware.ts (it is the door, it cannot be behind itself).

import type { NextApiRequest, NextApiResponse } from 'next';
import { checkStaffPassword, hasStaffSecret, mintStaffSession, staffCookieHeader } from '@/lib/security/staffSession';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!hasStaffSecret()) return res.status(503).json({ error: 'ADMIN_SECRET is not configured' });

  const password = String(req.body?.password ?? '');
  if (!(await checkStaffPassword(password))) {
    // One deliberate second, so the shared password is not worth grinding at.
    await new Promise((r) => setTimeout(r, 1000));
    return res.status(401).json({ error: 'incorrect password' });
  }

  res.setHeader('Set-Cookie', staffCookieHeader(await mintStaffSession()));
  return res.status(200).json({ ok: true });
}
