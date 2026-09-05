// lib/security/hmac.ts — HMAC-SHA256 sign/verify that works in BOTH runtimes.
//
// middleware.ts runs on the Edge runtime, where `node:crypto` is unavailable, and the API routes run
// on Node. Web Crypto (`globalThis.crypto.subtle`) is present in both, so every signed artifact in
// this app (client profile tokens, staff session cookies) goes through here and nowhere else.
//
// Constant-time comparison matters: a byte-by-byte early return leaks the signature one byte at a
// time to anyone willing to time a few thousand requests.

const enc = new TextEncoder();

/** base64url WITHOUT padding — safe in a URL, a cookie, and a GHL merge field. */
export function b64uEncode(bytes: Uint8Array | string): string {
  const b = typeof bytes === 'string' ? enc.encode(bytes) : bytes;
  let s = '';
  // Indexed rather than for..of: the tsconfig target predates downlevel iteration of typed arrays.
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecodeToString(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** base64url HMAC-SHA256 of `data`. */
export async function sign(data: string, secret: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await key(secret), enc.encode(data));
  return b64uEncode(new Uint8Array(sig));
}

/** Constant-time string compare. Length is allowed to leak; the content is not. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify and decode a `<payload>.<sig>` artifact. Returns the parsed payload, or null for anything
 * wrong: malformed, bad signature, unparseable JSON, or past its `exp`.
 *
 * Signature is checked BEFORE the payload is parsed as JSON — never parse attacker-controlled bytes
 * you have not authenticated.
 */
export async function verifySigned<T extends { exp?: number }>(
  token: string | undefined | null,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<T | null> {
  if (!token || !secret) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  const expected = await sign(body, secret);
  if (!timingSafeEqual(provided, expected)) return null;

  let payload: T;
  try {
    payload = JSON.parse(b64uDecodeToString(body)) as T;
  } catch {
    return null;
  }
  if (typeof payload?.exp === 'number' && payload.exp <= now) return null;
  return payload;
}

/** Build a `<payload>.<sig>` artifact. */
export async function makeSigned(payload: Record<string, unknown>, secret: string): Promise<string> {
  const body = b64uEncode(JSON.stringify(payload));
  return `${body}.${await sign(body, secret)}`;
}
