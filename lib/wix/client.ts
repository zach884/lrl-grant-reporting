// lib/wix/client.ts — the single fetch client every Wix call goes through.
//
// Mirrors lib/ghl/client.ts (token-bucket rate limit, retry/backoff on 429/5xx/network) and
// adds an OAuth token manager: it exchanges the app's client credentials for a short-lived
// access token, caches it until just before expiry, and refreshes on demand / on a 401.

import { getWixConfig, WixConfig } from './config';
import { WixApiError } from './errors';

export interface WixRequestOptions {
  method?: string;
  /** Path beginning with "/", e.g. "/wix-data/v2/items/query", or an absolute URL. */
  path: string;
  params?: Record<string, string | number | undefined>;
  body?: unknown;
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = Number(process.env.WIX_MAX_ATTEMPTS) || 5;
const BASE_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 16000;
/** Refresh the access token this many ms before it actually expires. */
const TOKEN_SKEW_MS = 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Global token bucket (bounds total throughput across concurrent workers). Wix bulk
// endpoints are generous, but a shared limiter keeps backfills from tripping 429s.
const MAX_RPS = Number(process.env.WIX_MAX_RPS) || 10;
class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly rate: number, private readonly capacity: number) {
    this.tokens = capacity;
  }
  private refill() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
  }
  async acquire(): Promise<void> {
    this.refill();
    while (this.tokens < 1) {
      const waitMs = Math.ceil(((1 - this.tokens) / this.rate) * 1000);
      await sleep(waitMs);
      this.refill();
    }
    this.tokens -= 1;
  }
}
const limiter = new TokenBucket(MAX_RPS, MAX_RPS);

export class WixClient {
  readonly config: WixConfig;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(config?: WixConfig) {
    this.config = config ?? getWixConfig();
  }

  get siteId(): string {
    return this.config.siteId;
  }

  /** Resolve a bearer token: static override, cached OAuth token, or a fresh exchange. */
  private async accessToken(force = false): Promise<string> {
    if (this.config.staticToken) return this.config.staticToken;
    if (!force && this.token && Date.now() < this.token.expiresAt - TOKEN_SKEW_MS) {
      return this.token.value;
    }
    const res = await fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': this.config.userAgent },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        instance_id: this.config.instanceId,
      }),
    });
    const text = await res.text();
    const parsed = parseJson(text) as { access_token?: string; expires_in?: number };
    if (!res.ok || !parsed?.access_token) {
      throw new WixApiError({ status: res.status, body: parsed ?? text, method: 'POST', path: '/oauth2/token', attempts: 1 });
    }
    this.token = {
      value: parsed.access_token,
      expiresAt: Date.now() + (parsed.expires_in ?? 300) * 1000,
    };
    return this.token.value;
  }

  private async headers(hasBody: boolean, token: string): Promise<Record<string, string>> {
    const h: Record<string, string> = {
      Authorization: token,
      Accept: 'application/json',
      'User-Agent': this.config.userAgent,
    };
    // Static API keys are site-scoped via a header; OAuth app tokens are instance-scoped.
    if (this.config.staticToken) h['wix-site-id'] = this.config.siteId;
    if (hasBody) h['Content-Type'] = 'application/json';
    return h;
  }

  private buildUrl(opts: WixRequestOptions): string {
    const isAbsolute = /^https?:\/\//i.test(opts.path);
    const url = new URL(isAbsolute ? opts.path : `${this.config.baseUrl}${opts.path}`);
    for (const [k, v] of Object.entries(opts.params ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  /** Core request with retry. Returns parsed JSON (typed as T). */
  async request<T = any>(opts: WixRequestOptions): Promise<T> {
    const method = opts.method ?? 'GET';
    const url = this.buildUrl(opts);
    const hasBody = opts.body !== undefined && opts.body !== null;
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    let attempt = 0;
    let lastErr: unknown;
    let forceToken = false;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        const token = await this.accessToken(forceToken);
        await limiter.acquire();
        const res = await fetch(url, {
          method,
          headers: await this.headers(hasBody, token),
          ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
        });

        const text = await res.text();
        const parsed = parseJson(text);

        if (res.ok) return parsed as T;

        // 401 with an OAuth token: the token may have expired early — refresh once and retry.
        if (res.status === 401 && !this.config.staticToken && !forceToken && attempt < maxAttempts) {
          forceToken = true;
          continue;
        }

        if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
          const retryAfter = Number(res.headers.get('retry-after'));
          const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt);
          await sleep(wait);
          continue;
        }

        throw new WixApiError({ status: res.status, body: parsed ?? text, method, path: opts.path, attempts: attempt });
      } catch (err) {
        if (err instanceof WixApiError) throw err;
        lastErr = err;
        if (attempt < maxAttempts) {
          await sleep(backoff(attempt));
          continue;
        }
      }
    }

    throw new WixApiError({
      status: 0,
      body: lastErr instanceof Error ? lastErr.message : String(lastErr),
      method,
      path: opts.path,
      attempts: attempt,
    });
  }
}

function backoff(attempt: number): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return base + Math.floor(Math.random() * 250);
}

function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Lazily-constructed default client bound to the env config. */
let _default: WixClient | null = null;
export function wix(): WixClient {
  if (!_default) _default = new WixClient();
  return _default;
}

export function resetDefaultWixClient(): void {
  _default = null;
}
