import type { NextApiRequest, NextApiResponse } from 'next';
import { clearStaffCookieHeader } from '@/lib/security/staffSession';

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Set-Cookie', clearStaffCookieHeader());
  return res.status(200).json({ ok: true });
}
