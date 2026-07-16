// lib/wix/index.ts — barrel for the Wix connector.

export { getWixConfig, hasWix, type WixConfig } from './config';
export { WixClient, wix, resetDefaultWixClient } from './client';
export { WixApiError, WixUnwritableFieldError } from './errors';
export * from './types';
export * from './collections';
export { importImageFromUrl, toImageFieldValue, type WixImportedFile } from './media';
export { coerceToWix, isUnwritableWixType, type WixCoerceResult, type GhlSourceType } from './coerce';
