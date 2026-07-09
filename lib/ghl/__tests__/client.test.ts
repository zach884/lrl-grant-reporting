import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GhlClient } from '../client';
import { GhlApiError } from '../errors';
import type { GhlConfig } from '../config';

const config: GhlConfig = {
  target: 'sandbox',
  baseUrl: 'https://api.test',
  apiKey: 'pit-test',
  locationId: 'LOC123',
  apiVersion: '2021-07-28',
  userAgent: 'lrl-ops-test/1.0',
};

function res(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GhlClient.request', () => {
  it('injects auth/version/user-agent headers and auto locationId', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { ok: true }));
    const client = new GhlClient(config);
    await client.request({ path: '/businesses/' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('https://api.test/businesses/');
    expect(url).toContain('locationId=LOC123');
    expect(init.headers.Authorization).toBe('Bearer pit-test');
    expect(init.headers.Version).toBe('2021-07-28');
    expect(init.headers['User-Agent']).toBe('lrl-ops-test/1.0');
  });

  it('does not double-inject locationId when caller supplies it', async () => {
    fetchMock.mockResolvedValueOnce(res(200, {}));
    const client = new GhlClient(config);
    await client.request({ path: '/businesses/', params: { locationId: 'OVERRIDE' } });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('locationId=OVERRIDE');
    expect(url).not.toContain('LOC123');
  });

  it('retries on 429 then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(res(429, { message: 'rate limited' }, { 'retry-after': '0' }))
      .mockResolvedValueOnce(res(200, { record: { id: 'x' } }));
    const client = new GhlClient(config);
    const out = await client.request<any>({ path: '/x', maxAttempts: 3 });
    expect(out.record.id).toBe('x');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on 500 then throws GhlApiError after exhausting attempts', async () => {
    fetchMock.mockResolvedValue(res(500, { message: 'boom' }));
    const client = new GhlClient(config);
    await expect(client.request({ path: '/x', maxAttempts: 2 })).rejects.toBeInstanceOf(GhlApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws immediately (no retry) on a 4xx like 422', async () => {
    fetchMock.mockResolvedValueOnce(res(422, { message: 'bad prop' }));
    const client = new GhlClient(config);
    await expect(client.request({ path: '/x' })).rejects.toMatchObject({
      status: 422,
      name: 'GhlApiError',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries GHL's transient 400 'Request Timeout' then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(res(400, { message: 'Request Timeout after 30000ms' }))
      .mockResolvedValueOnce(res(200, { contacts: [{ id: 'c1' }] }));
    const client = new GhlClient(config);
    const out = await client.request<any>({ path: '/contacts/', maxAttempts: 3 });
    expect(out.contacts[0].id).toBe('c1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats an absolute URL (nextPageUrl) as-is without re-injecting baseUrl', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { contacts: [] }));
    const client = new GhlClient(config);
    await client.request({ path: 'https://api.test/contacts/?page=2&x=1', autoLocation: false });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/contacts/?page=2&x=1');
  });
});
