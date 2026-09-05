// Pins the behaviour the whole client-facing surface rests on. A regression here is not a broken
// test, it is a public company profile.

import { describe, expect, it, beforeEach } from 'vitest';
import { makeSigned, verifySigned, timingSafeEqual, b64uEncode, b64uDecodeToString } from '../hmac';
import { mintClientToken, verifyClientToken } from '../clientToken';

const SECRET = 'test-secret-do-not-use';

describe('hmac', () => {
  it('round-trips base64url without padding', () => {
    expect(b64uDecodeToString(b64uEncode('hello ünïcode ??'))).toBe('hello ünïcode ??');
    expect(b64uEncode('any')).not.toContain('=');
  });

  it('verifies a signature it made', async () => {
    const t = await makeSigned({ a: 1, exp: 9999999999 }, SECRET);
    expect(await verifySigned<any>(t, SECRET)).toMatchObject({ a: 1 });
  });

  it('rejects a tampered payload', async () => {
    const t = await makeSigned({ a: 1, exp: 9999999999 }, SECRET);
    const [body, sig] = t.split('.');
    const evil = b64uEncode(JSON.stringify({ a: 2, exp: 9999999999 }));
    expect(await verifySigned(`${evil}.${sig}`, SECRET)).toBeNull();
  });

  it('rejects a wrong secret, a malformed token, and an empty one', async () => {
    const t = await makeSigned({ exp: 9999999999 }, SECRET);
    expect(await verifySigned(t, 'other-secret')).toBeNull();
    expect(await verifySigned('no-dot-here', SECRET)).toBeNull();
    expect(await verifySigned('.', SECRET)).toBeNull();
    expect(await verifySigned('', SECRET)).toBeNull();
    expect(await verifySigned(undefined, SECRET)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const t = await makeSigned({ exp: 1000 }, SECRET);
    expect(await verifySigned(t, SECRET)).toBeNull();
    // ...and accepts it when it is still in date.
    expect(await verifySigned(t, SECRET, 999)).toMatchObject({ exp: 1000 });
  });

  it('timingSafeEqual is correct as well as constant-time', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'ab')).toBe(false);
  });
});

describe('client token', () => {
  beforeEach(() => { process.env.CLIENT_LINK_SECRET = SECRET; });

  it('carries the contact and company through', async () => {
    const t = await mintClientToken('contact_1', 'biz_1');
    expect(await verifyClientToken(t)).toMatchObject({ c: 'contact_1', b: 'biz_1' });
  });

  it('cannot be re-pointed at another company', async () => {
    const t = await mintClientToken('contact_1', 'biz_1');
    const [, sig] = t.split('.');
    const swapped = b64uEncode(JSON.stringify({ c: 'contact_1', b: 'biz_VICTIM', exp: 9999999999 }));
    expect(await verifyClientToken(`${swapped}.${sig}`)).toBeNull();
  });

  it('refuses everything when the secret is unset', async () => {
    const t = await mintClientToken('contact_1', 'biz_1');
    delete process.env.CLIENT_LINK_SECRET;
    expect(await verifyClientToken(t)).toBeNull();
  });

  it('honours the ttl', async () => {
    const expired = await mintClientToken('c', 'b', -1);
    expect(await verifyClientToken(expired)).toBeNull();
  });
});
