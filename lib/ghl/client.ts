// lib/ghl/client.ts — the single fetch client every GHL call goes through.
// Encapsulates: auth + Version + User-Agent headers, query-param building,
// JSON handling, typed errors, and retry/backoff on 429 + 5xx + network errors.

import { getGhlConfig, GhlConfig, GhlTarget } from './config';
import { GhlApiError } from './errors';

export interface GhlRequestOptions {
  method?: string;
  /** Path beginning with "/", e.g. "/businesses/". */
  path: string;
  /** Query params. locationId is added automatically unless present or disabled. */
  params?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Set false to omit the automatic locationId query param (rare). */
  autoLocation?: boolean;
  /** Override retry attempts for this call (default 4). */
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = Number(process.env.GHL_MAX_ATTEMPTS) || 6;
const BASE_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 16000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- Global rate limiter -------------------------------------------------
// GHL's LeadConnector API caps at ~100 requests / 10s (≈10 req/s sustained) per
// location, plus a daily cap. A module-level token bucket bounds TOTAL throughput
// across every caller/concurrent worker, so high app-level concurrency can't cause
// a 429 storm. Starts full, so low-volume callers + unit tests see no delay.
const MAX_RPS = Number(process.env.GHL_MAX_RPS) || 8;
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

export class GhlClient {
  readonly config: GhlConfig;

  constructor(config?: GhlConfig | GhlTarget) {
    this.config =
      typeof config === 'string' || config === undefined
        ? getGhlConfig(config)
        : config;
  }

  get locationId(): string {
    return this.config.locationId;
  }

  private headers(hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Version: this.config.apiVersion,
      Accept: 'application/json',
      'User-Agent': this.config.userAgent,
    };
    if (hasBody) h['Content-Type'] = 'application/json';
    return h;
  }

  private buildUrl(opts: GhlRequestOptions): string {
    // Support absolute URLs (e.g. meta.nextPageUrl from paginated list endpoints):
    // use them as-is, do not re-inject baseUrl/locationId.
    const isAbsolute = /^https?:\/\//i.test(opts.path);
    const url = new URL(isAbsolute ? opts.path : `${this.config.baseUrl}${opts.path}`);
    const params = { ...(opts.params ?? {}) };
    if (isAbsolute) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
      return url.toString();
    }
    if (opts.autoLocation !== false && params.locationId === undefined) {
      params.locationId = this.config.locationId;
    }
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  /** Core request with retry. Returns parsed JSON (typed as T). */
  async request<T = any>(opts: GhlRequestOptions): Promise<T> {
    const method = opts.method ?? 'GET';
    const url = this.buildUrl(opts);
    const hasBody = opts.body !== undefined && opts.body !== null;
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    let attempt = 0;
    let lastErr: unknown;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        await limiter.acquire();
        const res = await fetch(url, {
          method,
          headers: this.headers(hasBody),
          ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
        });

        const text = await res.text();
        const parsed = parseJson(text);

        if (res.ok) return parsed as T;

        // Non-2xx. Retry on 429/5xx and GHL's transient "Request Timeout" 400s (its contacts
        // list times out server-side ~30s under deep pagination), respecting Retry-After.
        const isTransientTimeout = res.status === 400 && /request timeout/i.test(text);
        if ((res.status === 429 || res.status >= 500 || isTransientTimeout) && attempt < maxAttempts) {
          const retryAfter = Number(res.headers.get('retry-after'));
          const wait = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : backoff(attempt);
          await sleep(wait);
          continue;
        }

        throw new GhlApiError({
          status: res.status,
          body: parsed ?? text,
          method,
          path: opts.path,
          attempts: attempt,
        });
      } catch (err) {
        // Network / fetch-level failure: retry with backoff, else rethrow.
        if (err instanceof GhlApiError) throw err;
        lastErr = err;
        if (attempt < maxAttempts) {
          await sleep(backoff(attempt));
          continue;
        }
      }
    }

    throw new GhlApiError({
      status: 0,
      body: lastErr instanceof Error ? lastErr.message : String(lastErr),
      method,
      path: opts.path,
      attempts: attempt,
    });
  }
}

function backoff(attempt: number): number {
  // Exponential + jitter: 400, 800, 1600ms ... capped.
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

/** Lazily-constructed default client bound to the env-selected target (live by default). */
let _default: GhlClient | null = null;
export function ghl(): GhlClient {
  if (!_default) _default = new GhlClient();
  return _default;
}

/** For tests/scripts that switch targets at runtime. */
export function resetDefaultClient(): void {
  _default = null;
}
