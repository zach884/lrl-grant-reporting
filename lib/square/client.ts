// lib/square/client.ts — thin fetch client for the Square Connect v2 API.
// Mirrors the shape of lib/ghl/client.ts: auth headers, JSON handling, and
// retry/backoff on 429 + 5xx + network errors. Read-only usage here.

import { getSquareConfig, SquareConfig } from './config';

const DEFAULT_MAX_ATTEMPTS = Number(process.env.SQUARE_MAX_ATTEMPTS) || 5;
const BASE_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 16000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SquareApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, path: string) {
    super(`Square API ${status} on ${path}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.name = 'SquareApiError';
    this.status = status;
    this.body = body;
  }
}

export interface SquareRequestOptions {
  method?: string;
  path: string; // e.g. "/v2/orders/search"
  body?: unknown;
  maxAttempts?: number;
}

export class SquareClient {
  readonly config: SquareConfig;
  constructor(config?: SquareConfig) {
    this.config = config ?? getSquareConfig();
  }

  get locationId(): string {
    return this.config.locationId;
  }

  private headers(hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.config.accessToken}`,
      Accept: 'application/json',
    };
    if (this.config.version) h['Square-Version'] = this.config.version;
    if (hasBody) h['Content-Type'] = 'application/json';
    return h;
  }

  async request<T = any>(opts: SquareRequestOptions): Promise<T> {
    const method = opts.method ?? 'GET';
    const url = `${this.config.baseUrl}${opts.path}`;
    const hasBody = opts.body !== undefined && opts.body !== null;
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    let attempt = 0;
    let lastErr: unknown;
    while (attempt < maxAttempts) {
      attempt++;
      try {
        const res = await fetch(url, {
          method,
          headers: this.headers(hasBody),
          ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
        });
        const text = await res.text();
        const parsed = text ? safeJson(text) : {};
        if (res.ok) return parsed as T;

        if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
          const retryAfter = Number(res.headers.get('retry-after'));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
          continue;
        }
        throw new SquareApiError(res.status, parsed, opts.path);
      } catch (err) {
        if (err instanceof SquareApiError) throw err;
        lastErr = err;
        if (attempt < maxAttempts) {
          await sleep(backoff(attempt));
          continue;
        }
      }
    }
    throw new SquareApiError(0, lastErr instanceof Error ? lastErr.message : String(lastErr), opts.path);
  }
}

function backoff(attempt: number): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return base + Math.floor(Math.random() * 250);
}
function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

let _default: SquareClient | null = null;
export function square(): SquareClient {
  if (!_default) _default = new SquareClient();
  return _default;
}
export function resetDefaultSquareClient(): void {
  _default = null;
}
