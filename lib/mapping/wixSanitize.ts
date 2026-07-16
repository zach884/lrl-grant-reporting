// lib/mapping/wixSanitize.ts — validate + normalize a WixMappingSet payload from the API.

import type { WixApplyPolicy, WixMappingRow, WixMappingSetInput, WixTransform } from './wixTypes';

const POLICIES: WixApplyPolicy[] = ['overwrite', 'fill-empty'];
const TRANSFORMS: WixTransform[] = ['html', 'arrayFromMultiSelect', 'imageFromUpload', 'referenceFromOptions', 'countryCode'];

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function sanitizeRow(raw: any): WixMappingRow | null {
  const sourceFieldKey = str(raw?.sourceFieldKey);
  const targetColumnKey = str(raw?.targetColumnKey);
  if (!sourceFieldKey || !targetColumnKey) return null;
  const row: WixMappingRow = { sourceFieldKey, targetColumnKey };
  if (TRANSFORMS.includes(raw?.transform)) row.transform = raw.transform;
  if (POLICIES.includes(raw?.policy)) row.policy = raw.policy;
  return row;
}

/** Throws Error with a message on invalid input; returns a clean WixMappingSetInput. */
export function sanitizeWixSet(body: any, defaultSiteId: string): WixMappingSetInput {
  const name = str(body?.name);
  const wixCollectionId = str(body?.wixCollectionId);
  const matchSourceField = str(body?.matchSourceField);
  const matchTargetColumn = str(body?.matchTargetColumn);
  if (!name) throw new Error('name is required');
  if (!wixCollectionId) throw new Error('wixCollectionId is required');
  if (!matchSourceField || !matchTargetColumn) throw new Error('matchSourceField and matchTargetColumn are required');

  const rows = Array.isArray(body?.rows) ? body.rows.map(sanitizeRow).filter(Boolean) : [];

  return {
    name,
    sourceObject: str(body?.sourceObject) || 'contact',
    wixSiteId: str(body?.wixSiteId) || defaultSiteId,
    wixCollectionId,
    matchSourceField,
    matchTargetColumn,
    policy: POLICIES.includes(body?.policy) ? body.policy : 'overwrite',
    enabled: body?.enabled !== false,
    rows: rows as WixMappingRow[],
  };
}
