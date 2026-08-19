// lib/ghl/fileUpload.ts — re-host a file into GHL so a FILE_UPLOAD field can actually hold it.
//
// THE PROBLEM: attaching a file to a FILE_UPLOAD field on an OBJECT record (business /
// custom_objects.*) sends `{add:[{url}]}`, and GHL fetches that url server-side. It refuses the
// `services.leadconnectorhq.com/documents/download/…` urls that its own FORM uploads produce:
//
//   PUT /objects/business/records/{id} -> 400
//   "We couldn't access the file link for Logo."
//
// So `contact.company_logo -> business.logo` could never work by reference. (This was invisible for
// weeks: the old code sent a plain string, which GHL answered 200 and stored as null.)
//
// THE FIX: download the bytes and re-upload them to the destination field, then attach the url GHL
// hands back — a `msgsndr-private.storage.googleapis.com/…` url, which GHL will fetch. This is the
// same manoeuvre used to move all 91 resource logos into GHL in the 2026-08-17 session; it is now
// code rather than a one-off.
//
// Endpoint (verified live 2026-08-18, HTTP 201): POST /locations/{locationId}/customFields/upload
// as multipart with `file`, `id` = the custom field id, and `maxFiles`. Response:
//   { uploadedFiles: { "<camelizedName>": "<hosted url>" }, meta: [{ originalname, mimetype, url, … }] }
// Note `uploadedFiles` KEYS are camelized ("fidelis_logo_color_large.png" -> "fidelisLogoColorLarge.png")
// while `meta[].originalname` preserves the real filename — which is what the idempotency guard in
// lib/ghl/objectWrite.ts compares on, so read the name from `meta`, never from the key.

import { GhlClient, ghl } from './client';

/** A file we can attach: where it lives now, and what it is called. */
export interface HostedFile {
  url: string;
  name?: string;
  mimeType?: string;
}

/** Filename from a url path, when the source didn't give us one. */
function nameFromUrl(url: string, fallback = 'upload'): string {
  try {
    const base = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    return /\.[a-z0-9]{2,5}$/i.test(base) ? base : fallback;
  } catch {
    return fallback;
  }
}

/** Is this a url GHL is known to refuse when re-attaching it to an object field? */
export function needsRehostForObjectField(url: string): boolean {
  // Its own form-upload links are the known-bad case. Already-hosted custom-field urls are fine.
  return /services\.leadconnectorhq\.com\/documents\/download\//i.test(url);
}

/**
 * Download `source` and upload it to `fieldId`, returning the GHL-hosted file.
 *
 * Throws on a failed download or upload — the caller decides whether that is fatal (in the sync it
 * is reported as a skipped field, never allowed to break the run).
 */
export async function rehostFileToField(
  source: HostedFile,
  fieldId: string,
  client: GhlClient = ghl(),
): Promise<HostedFile> {
  const name = source.name?.trim() || nameFromUrl(source.url);

  const resp = await fetch(source.url);
  if (!resp.ok) throw new Error(`could not download ${source.url} (HTTP ${resp.status})`);
  const mimeType = source.mimeType || resp.headers.get('content-type') || 'application/octet-stream';
  const bytes = Buffer.from(await resp.arrayBuffer());
  if (!bytes.length) throw new Error(`downloaded 0 bytes from ${source.url}`);

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType }), name);
  form.append('id', fieldId);
  form.append('maxFiles', '1');

  // Multipart, so this bypasses the JSON client — but reuse its auth + base url.
  const res = await client.request<any>({
    method: 'POST',
    path: `/locations/${client.locationId}/customFields/upload`,
    autoLocation: false,
    body: form,
  });

  // Prefer meta[].url + originalname: the uploadedFiles keys are camelized and lose the real name.
  const meta = Array.isArray(res?.meta) ? res.meta[0] : undefined;
  const hostedUrl = meta?.url ?? Object.values(res?.uploadedFiles ?? {})[0];
  if (typeof hostedUrl !== 'string' || !hostedUrl) {
    throw new Error(`upload returned no url (${JSON.stringify(res).slice(0, 200)})`);
  }
  return { url: hostedUrl, name: meta?.originalname ?? name, mimeType: meta?.mimetype ?? mimeType };
}
