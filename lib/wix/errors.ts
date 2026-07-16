// lib/wix/errors.ts — typed Wix API errors (mirrors lib/ghl/errors.ts).

/** Thrown for any non-2xx Wix response, or a network failure after retries. */
export class WixApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly method: string;
  readonly path: string;
  readonly attempts: number;

  constructor(args: { status: number; body: unknown; method: string; path: string; attempts: number }) {
    const msg =
      typeof args.body === 'object' && args.body !== null && 'message' in args.body
        ? String((args.body as { message: unknown }).message)
        : typeof args.body === 'string'
          ? args.body
          : '';
    super(
      `Wix ${args.method} ${args.path} -> ${args.status}` +
        (msg ? `: ${msg}` : '') +
        (args.attempts > 1 ? ` (after ${args.attempts} attempts)` : ''),
    );
    this.name = 'WixApiError';
    this.status = args.status;
    this.body = args.body;
    this.method = args.method;
    this.path = args.path;
    this.attempts = args.attempts;
  }

  get isRetryable(): boolean {
    return this.status === 429 || (this.status >= 500 && this.status <= 599);
  }
}

/** Thrown when a caller tries to write a Wix column type that can't be set via the
 *  Data API insert/update/patch path (system fields, PAGE_LINK, MULTI_REFERENCE via
 *  the normal body — those go through the reference endpoints). */
export class WixUnwritableFieldError extends Error {
  readonly columnKey: string;
  readonly fieldType: string;
  constructor(columnKey: string, fieldType: string, detail?: string) {
    super(
      `Wix column "${columnKey}" (${fieldType}) cannot be written via the Data API item body` +
        (detail ? `: ${detail}` : '.'),
    );
    this.name = 'WixUnwritableFieldError';
    this.columnKey = columnKey;
    this.fieldType = fieldType;
  }
}
