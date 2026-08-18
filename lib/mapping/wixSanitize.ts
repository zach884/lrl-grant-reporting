// lib/mapping/wixSanitize.ts — validate + normalize a WixMappingSet payload from the API.
//
// The engine-critical gate fields (gate/visibility/writebackField/secondaryMatch/createPolicy) are
// passed through ONLY when the request body actually carries the key. That distinction is load-bearing:
//   • key ABSENT   => the field is left off the sanitized input (undefined) => saveSet PRESERVES the
//     stored value. This is what protects a rows-only save from nulling the gate (the 2026-07-21
//     CMS-flood incident) even if a caller never learns about gates.
//   • key PRESENT  => the value is validated and applied; an explicit `null` clears it (a real gate
//     editor). So the /wix-sync "Gate & visibility" panel round-trips and can both set and clear.

import type {
  GateAction,
  WixApplyPolicy,
  WixCreatePolicy,
  WixGate,
  WixMappingRow,
  WixMappingSetInput,
  WixSecondaryMatch,
  WixTransform,
  WixVisibility,
} from './wixTypes';

const POLICIES: WixApplyPolicy[] = ['overwrite', 'fill-empty'];
const CREATE_POLICIES: WixCreatePolicy[] = ['update_only', 'find_or_create'];
const GATE_ACTIONS: GateAction[] = ['upsert', 'update', 'hide', 'skip'];
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
  // valueMap: a flat {string: string} map. Silently drop non-string entries rather than persisting
  // something the engine can't use; an empty map is treated as absent.
  if (raw?.valueMap != null) {
    if (typeof raw.valueMap !== 'object' || Array.isArray(raw.valueMap)) throw new Error('valueMap must be an object');
    const vm: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.valueMap as Record<string, unknown>)) {
      const kk = str(k); const vv = str(v);
      if (kk && vv) vm[kk] = vv;
    }
    if (Object.keys(vm).length) row.valueMap = vm;
  }
  return row;
}

/** Status→action gate. `null` clears; an object validates field + action map (+ optional publish status). */
export function sanitizeGate(raw: any): WixGate | null {
  if (raw == null) return null;
  if (typeof raw !== 'object') throw new Error('gate must be an object or null');
  const field = str(raw.field);
  if (!field) throw new Error('gate.field is required');
  const actions: Record<string, GateAction> = {};
  const rawActions = raw.actions;
  if (rawActions != null) {
    if (typeof rawActions !== 'object' || Array.isArray(rawActions)) throw new Error('gate.actions must be an object');
    for (const [k, v] of Object.entries(rawActions)) {
      const key = str(k);
      if (!key) continue;
      if (!GATE_ACTIONS.includes(v as GateAction)) throw new Error(`invalid gate action for "${key}": ${String(v)}`);
      actions[key] = v as GateAction;
    }
  }
  const gate: WixGate = { field, actions };
  const onPublish = str(raw.onPublishSetStatus);
  if (onPublish) gate.onPublishSetStatus = onPublish;
  return gate;
}

/** Visibility mode. `null` clears; publishState or a column with visible/hidden values. */
export function sanitizeVisibility(raw: any): WixVisibility | null {
  if (raw == null) return null;
  if (typeof raw !== 'object') throw new Error('visibility must be an object or null');
  if (raw.mode === 'publishState') return { mode: 'publishState' };
  if (raw.mode === 'column') {
    const column = str(raw.column);
    if (!column) throw new Error('visibility.column is required for column mode');
    return { mode: 'column', column, visibleValue: str(raw.visibleValue), hiddenValue: str(raw.hiddenValue) };
  }
  throw new Error('visibility.mode must be "publishState" or "column"');
}

/** First-link dedup keys. `null` clears; drops incomplete pairs. */
export function sanitizeSecondaryMatch(raw: any): WixSecondaryMatch[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) throw new Error('secondaryMatch must be an array or null');
  const out: WixSecondaryMatch[] = [];
  for (const m of raw) {
    const sourceField = str(m?.sourceField);
    const targetColumn = str(m?.targetColumn);
    if (sourceField && targetColumn) out.push({ sourceField, targetColumn });
  }
  return out;
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

  const input: WixMappingSetInput = {
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

  // Engine-critical fields: pass through ONLY when the caller sent the key (see file header).
  if (body && 'createPolicy' in body) {
    input.createPolicy = CREATE_POLICIES.includes(body.createPolicy) ? body.createPolicy : 'find_or_create';
  }
  if (body && 'gate' in body) input.gate = sanitizeGate(body.gate);
  if (body && 'visibility' in body) input.visibility = sanitizeVisibility(body.visibility);
  if (body && 'secondaryMatch' in body) input.secondaryMatch = sanitizeSecondaryMatch(body.secondaryMatch);
  if (body && 'writebackField' in body) {
    const wb = body.writebackField;
    input.writebackField = wb == null || wb === '' ? null : str(wb);
  }

  return input;
}
