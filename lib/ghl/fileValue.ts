// lib/ghl/fileValue.ts — read the URLs out of a GHL FILE_UPLOAD value.
//
// PURE. One canonical extractor because GHL stores this field in THREE different shapes
// depending on how the file arrived, and every consumer needs all three:
//
//   1. a bare url string                       "https://…/photo.jpg"
//   2. an array of descriptors                 [{ url, meta? }, …]  (or an array of strings)
//   3. a UUID-KEYED MAP  ← the form-upload shape, and the one we missed until 2026-08-17
//      { "ced71d35-1d7a-48fa-89ec-400fa054d091": { meta: {...}, url: "https://…" } }
//
// Shape 3 is what a file uploaded through a GHL *form* stores, so handling only 1 and 2
// meant every form-submitted headshot and company logo silently never reached Wix
// (`fileUrl()` returned null → the sync reported "no file url" and skipped the column).
//
// Both `services.leadconnectorhq.com/documents/download/…` (form uploads) and
// `msgsndr-private.storage.googleapis.com/…` (API uploads) URLs are publicly fetchable,
// so Wix's media import accepts either.

const HTTP_URL = /^https?:\/\//i;

function urlFromEntry(entry: unknown): string | null {
  if (typeof entry === 'string') return HTTP_URL.test(entry.trim()) ? entry.trim() : null;
  if (entry && typeof entry === 'object') {
    const u = (entry as { url?: unknown }).url;
    if (typeof u === 'string' && HTTP_URL.test(u.trim())) return u.trim();
  }
  return null;
}

/** A file as stored on a GHL record: where it is, and the name it was uploaded under. */
export interface FileEntry {
  url: string;
  /** GHL's `meta.originalname` — preserved across a re-upload, so it is the stable identity. */
  name?: string;
}

function entryFrom(entry: unknown): FileEntry | null {
  const url = urlFromEntry(entry);
  if (!url) return null;
  const name =
    entry && typeof entry === 'object'
      ? (entry as any)?.meta?.originalname ?? (entry as any)?.originalname ?? (entry as any)?.meta?.name ?? (entry as any)?.name
      : undefined;
  return { url, name: typeof name === 'string' && name.trim() ? name.trim() : undefined };
}

/**
 * Every file on a FILE_UPLOAD value as {url, name}, deduped by url.
 *
 * The NAME matters for idempotency: re-hosting a file into GHL necessarily changes its url, so url
 * equality can never tell "already attached" from "needs attaching" and a sync would re-upload
 * forever. `meta.originalname` survives the round trip, so it is what the write path compares on.
 */
export function fileEntries(value: unknown): FileEntry[] {
  if (value == null || value === '') return [];
  const out: FileEntry[] = [];
  const push = (e: FileEntry | null) => {
    if (e && !out.some((x) => x.url === e.url)) out.push(e);
  };
  if (typeof value === 'string') { push(entryFrom(value)); return out; }
  if (Array.isArray(value)) { for (const v of value) push(entryFrom(v)); return out; }
  if (typeof value === 'object') {
    const direct = entryFrom(value);
    // A bare descriptor {url, meta} vs a uuid-keyed map of them.
    if (direct) { push(direct); return out; }
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      push(entryFrom((value as Record<string, unknown>)[k]));
    }
  }
  return out;
}

/**
 * Every file URL in a GHL FILE_UPLOAD value, in a stable order, deduped.
 * Returns [] for empty/unrecognized values — callers decide whether that's a skip.
 */
export function fileUrls(value: unknown): string[] {
  if (value == null || value === '') return [];

  const out: string[] = [];
  const push = (u: string | null) => {
    if (u && !out.includes(u)) out.push(u);
  };

  // 1. bare url string
  if (typeof value === 'string') {
    push(urlFromEntry(value));
    return out;
  }

  // 2. array of descriptors / strings
  if (Array.isArray(value)) {
    for (const entry of value) push(urlFromEntry(entry));
    return out;
  }

  if (typeof value === 'object') {
    // A single descriptor { url, meta? } — check before treating it as a keyed map, since a
    // descriptor is also an object with entries.
    const direct = urlFromEntry(value);
    if (direct) {
      push(direct);
      return out;
    }
    // 3. uuid-keyed map { <uuid>: { meta, url } } — sort keys so the order is deterministic
    //    across reads (GHL does not guarantee object key order).
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      push(urlFromEntry((value as Record<string, unknown>)[key]));
    }
  }

  return out;
}

/** The first file URL, or null. Use when a target holds a single file (e.g. a Wix IMAGE column). */
export function firstFileUrl(value: unknown): string | null {
  return fileUrls(value)[0] ?? null;
}
