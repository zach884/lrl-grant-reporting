// lib/security/clientToken.ts — the capability a client gets emailed.
//
// One token names one contact AND one company. The API takes BOTH ids from the verified payload and
// never from the request, so `/api/client-profile` can't be turned into "read any company by id" —
// which is exactly what a raw `?cid={{contact.id}}` link would have made it.
//
// Bound to the company as well as the contact on purpose: `contact.businessId` can be re-pointed
// (a job change), and a token minted for Acme must not silently start editing Globex.
//
// Minted ahead of the email send by scripts-ts/mint-rescore-links.ts and stored on
// `contact.rescore_token`, because GHL can compute a merge field but not an HMAC.

import { makeSigned, verifySigned } from './hmac';

export interface ClientTokenPayload {
  /** contact id */
  c: string;
  /** business (company) id */
  b: string;
  /** unix seconds */
  exp: number;
}

export const DEFAULT_TTL_DAYS = 90;

function secret(): string {
  const s = process.env.CLIENT_LINK_SECRET;
  if (!s) throw new Error('CLIENT_LINK_SECRET is not set — refusing to mint or accept client links');
  return s;
}

/** True when the secret is configured. Lets a handler return 503 instead of throwing a 500. */
export const hasClientLinkSecret = (): boolean => Boolean(process.env.CLIENT_LINK_SECRET);

export function mintClientToken(
  contactId: string,
  businessId: string,
  ttlDays: number = DEFAULT_TTL_DAYS,
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + Math.round(ttlDays * 86400);
  return makeSigned({ c: contactId, b: businessId, exp }, secret());
}

/** null for malformed, tampered, or expired. Callers must treat null as 401 and say nothing more. */
export async function verifyClientToken(token: string | undefined | null): Promise<ClientTokenPayload | null> {
  if (!hasClientLinkSecret()) return null;
  const p = await verifySigned<ClientTokenPayload>(token, secret());
  if (!p || typeof p.c !== 'string' || typeof p.b !== 'string' || !p.c || !p.b) return null;
  return p;
}
