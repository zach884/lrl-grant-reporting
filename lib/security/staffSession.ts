// lib/security/staffSession.ts — the staff side of the door.
//
// INTERIM BY DESIGN. The correct GHL answer is the Marketplace-app SSO handshake (encrypted user data
// over postMessage, decrypted with the location's SSO key), which gives real per-user attribution.
// There is no Marketplace app on this location and no SSO key in the environment, so this is a shared
// credential: one password (`ADMIN_SECRET`) exchanged for a signed, expiring, httpOnly cookie.
//
// It is not worse than what it replaces — today all 42 non-webhook API routes are open to the
// internet — and when the SSO handshake lands it replaces `verifyStaffSession` alone, not the
// middleware around it.
//
// SameSite=None is REQUIRED: the staff app is embedded in GHL as a cross-site iframe, and a Lax
// cookie is simply not sent there. None demands Secure, which production is.

import { makeSigned, verifySigned } from './hmac';

export const STAFF_COOKIE = 'lrl_staff';
const TTL_SECONDS = 30 * 86400;

export interface StaffSession {
  /** Who, when we can tell. Today the shared login has no identity, so this is 'staff'. */
  u: string;
  exp: number;
}

function secret(): string {
  const s = process.env.ADMIN_SECRET;
  if (!s) throw new Error('ADMIN_SECRET is not set — staff auth cannot operate');
  return s;
}

export const hasStaffSecret = (): boolean => Boolean(process.env.ADMIN_SECRET);

/** Does the submitted password match? Constant-time via the HMAC path, not a string compare. */
export async function checkStaffPassword(provided: string): Promise<boolean> {
  if (!hasStaffSecret() || !provided) return false;
  const { sign, timingSafeEqual } = await import('./hmac');
  const a = await sign(provided, 'lrl-staff-login');
  const b = await sign(secret(), 'lrl-staff-login');
  return timingSafeEqual(a, b);
}

export function mintStaffSession(user = 'staff'): Promise<string> {
  return makeSigned({ u: user, exp: Math.floor(Date.now() / 1000) + TTL_SECONDS }, secret());
}

export async function verifyStaffSession(cookieValue: string | undefined | null): Promise<StaffSession | null> {
  if (!hasStaffSecret()) return null;
  return verifySigned<StaffSession>(cookieValue, secret());
}

/** The Set-Cookie value. httpOnly so page JS (and anything injected into it) cannot read it. */
export function staffCookieHeader(token: string): string {
  return [
    `${STAFF_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=None',
    `Max-Age=${TTL_SECONDS}`,
  ].join('; ');
}

export function clearStaffCookieHeader(): string {
  return `${STAFF_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
}
