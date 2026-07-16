// lib/wix/media.ts — import an external (GHL) file URL into the Wix Media Manager.
//
//   POST /site-media/v1/files/import  { url, mimeType?, displayName?, mediaType?:'IMAGE' }
//   -> { file: { id, url, ... } }
//
// Caveats (per Wix docs):
//   - Import is ASYNC: the file "isn't immediately available" after a 200. For CMS IMAGE
//     columns the returned descriptor is enough to reference it; live verification will
//     confirm the exact value shape a collection IMAGE field expects (`wix:image://…`).
//   - Provide the MIME type OR an extension in url/displayName so Wix can classify it.

import { WixClient, wix } from './client';

export interface WixImportedFile {
  id: string;
  url?: string;
  displayName?: string;
}

function guessDisplayName(sourceUrl: string, fallback: string): string {
  try {
    const p = new URL(sourceUrl).pathname;
    const base = p.split('/').filter(Boolean).pop();
    return base && /\.[a-z0-9]+$/i.test(base) ? base : fallback;
  } catch {
    return fallback;
  }
}

/** Import an image from an external URL; returns the Wix file descriptor. */
export async function importImageFromUrl(
  sourceUrl: string,
  opts: { displayName?: string; mimeType?: string } = {},
  client: WixClient = wix(),
): Promise<WixImportedFile> {
  const displayName = opts.displayName ?? guessDisplayName(sourceUrl, 'import.jpg');
  const res = await client.request<any>({
    method: 'POST',
    path: '/site-media/v1/files/import',
    body: {
      url: sourceUrl,
      displayName,
      mediaType: 'IMAGE',
      ...(opts.mimeType ? { mimeType: opts.mimeType } : {}),
    },
  });
  const file = res.file ?? res;
  return { id: file.id, url: file.url, displayName: file.displayName };
}

/**
 * Convert an imported file descriptor to the value a CMS IMAGE column stores.
 * Wix IMAGE fields accept a `wix:image://` static URI; the descriptor's `url` is already
 * a `wix:image://…` value for imported media. Falls back to the raw id if url is absent.
 */
export function toImageFieldValue(file: WixImportedFile): string {
  return file.url ?? file.id;
}
