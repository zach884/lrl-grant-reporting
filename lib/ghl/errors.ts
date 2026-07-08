// lib/ghl/errors.ts — typed GHL API errors

/** Thrown for any non-2xx GHL response, or a network failure after retries. */
export class GhlApiError extends Error {
  readonly status: number;
  /** Parsed JSON body if the response was JSON, else the raw text. */
  readonly body: unknown;
  readonly method: string;
  readonly path: string;
  /** How many attempts were made before giving up. */
  readonly attempts: number;

  constructor(args: {
    status: number;
    body: unknown;
    method: string;
    path: string;
    attempts: number;
  }) {
    const msg =
      typeof args.body === 'object' && args.body !== null && 'message' in args.body
        ? String((args.body as { message: unknown }).message)
        : typeof args.body === 'string'
          ? args.body
          : '';
    super(
      `GHL ${args.method} ${args.path} -> ${args.status}` +
        (msg ? `: ${msg}` : '') +
        (args.attempts > 1 ? ` (after ${args.attempts} attempts)` : ''),
    );
    this.name = 'GhlApiError';
    this.status = args.status;
    this.body = args.body;
    this.method = args.method;
    this.path = args.path;
    this.attempts = args.attempts;
  }

  /** True for statuses that are safe/expected to retry. */
  get isRetryable(): boolean {
    return this.status === 429 || (this.status >= 500 && this.status <= 599);
  }
}

/**
 * Thrown when a caller tries to write a field type that GHL silently drops
 * over the API (CHECKBOX / TEXTBOX_LIST / MULTIPLE_OPTIONS on the business object).
 * Surfaced loudly instead of failing silently, per the confirmed API quirks.
 */
export class GhlUnwritableFieldError extends Error {
  readonly fieldKey: string;
  readonly dataType: string;
  constructor(fieldKey: string, dataType: string) {
    super(
      `Field "${fieldKey}" (${dataType}) cannot be written via the GHL API ` +
        `(it returns 200 but silently drops the value). Maintain it in the GHL UI, ` +
        `or model it as SINGLE_OPTIONS/TEXT.`,
    );
    this.name = 'GhlUnwritableFieldError';
    this.fieldKey = fieldKey;
    this.dataType = dataType;
  }
}
