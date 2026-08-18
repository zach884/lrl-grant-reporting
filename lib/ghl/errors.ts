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
    // ALWAYS surface the full body, not just `message`. A truncated 422 hid the
    // MULTIPLE_OPTIONS `{add,remove}` modifier contract for six weeks in 2026 — GHL puts the
    // actionable detail in sibling keys, and the phrases "unexpected format" / "couldn't
    // process file updates" are the tell that it wants a modifier rather than a value.
    let full = '';
    if (typeof args.body === 'object' && args.body !== null) {
      try {
        const json = JSON.stringify(args.body);
        // Skip when the body is just {message} and adds nothing beyond what's already shown.
        if (json && json !== `{"message":${JSON.stringify(msg)}}`) {
          full = ` body=${json.length > 2000 ? `${json.slice(0, 2000)}…(truncated)` : json}`;
        }
      } catch {
        full = ` body=${String(args.body)}`;
      }
    }
    super(
      `GHL ${args.method} ${args.path} -> ${args.status}` +
        (msg ? `: ${msg}` : '') +
        (args.attempts > 1 ? ` (after ${args.attempts} attempts)` : '') +
        full,
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
 * Thrown when a caller tries to write a field type that GHL silently drops over the API
 * (CHECKBOX / TEXTBOX_LIST). Surfaced loudly instead of failing silently.
 *
 * NOTE: MULTIPLE_OPTIONS was in this club until 2026-08-17 — it is updatable after all, via an
 * `{add,remove}` modifier (see lib/ghl/coerce.ts). CHECKBOX / TEXTBOX_LIST are still due a
 * re-probe with that same shape before we keep trusting "UI only".
 */
export class GhlUnwritableFieldError extends Error {
  readonly fieldKey: string;
  readonly dataType: string;
  constructor(fieldKey: string, dataType: string, detail?: string) {
    super(
      `Field "${fieldKey}" (${dataType}) cannot be written via the GHL API ` +
        (detail ??
          `(it returns 200 but silently drops the value). Maintain it in the GHL UI, ` +
            `or model it as SINGLE_OPTIONS/TEXT.`),
    );
    this.name = 'GhlUnwritableFieldError';
    this.fieldKey = fieldKey;
    this.dataType = dataType;
  }
}
