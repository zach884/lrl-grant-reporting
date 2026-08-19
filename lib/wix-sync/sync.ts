// lib/wix-sync/sync.ts — outbound sync of one GHL record to its Wix CMS row.
//
// Flow: read the GHL source record -> coerce each mapped field to its Wix column ->
// query the target collection by the match key -> INSERT (new) or bulk-PATCH (existing)
// the plain-value fields -> import IMAGE files + set (MULTI_)REFERENCE targets as a
// second pass (they need the item id / async media). An equality guard makes re-runs
// no-ops. Nothing is written unless opts.apply is true (dry-run returns the same plan).

import { getContact } from '../ghl/contacts';
import { GhlClient, ghl } from '../ghl/client';
import { writeRecordFields } from '../ghl/writeRecord';
import { readRecordFields } from '../ghl/records';
import type { Contact, CustomFieldCatalog, GhlFieldOption } from '../ghl/types';
import type { GateAction, WixMappingSet } from '../mapping/wixTypes';
import { WixClient, wix } from '../wix/client';
import { coerceToWix, isUnwritableWixType, type GhlSourceType } from '../wix/coerce';
import {
  getCollectionSchema,
  insertItem,
  patchItem,
  queryItemByMatch,
  queryItemsByColumn,
  replaceReferences,
  referencedIds,
  resolveReferenceIds,
  setPublishStatus,
  type FieldModification,
} from '../wix/collections';
import { importImageFromUrl, toImageFieldValue } from '../wix/media';
import { logChange } from '../audit/log';
import { labelFromFields } from '../audit/label';
import type { WixCollectionSchema, WixColumn } from '../wix/types';
import type { WixFieldChange, WixSyncResult } from './types';

interface SourceField {
  value: unknown;
  ghlType: GhlSourceType;
  options?: GhlFieldOption[];
}

/** Read a source field value (standard scalar or custom field) off a GHL contact. */
export function resolveContactField(
  contact: Contact,
  catalog: CustomFieldCatalog,
  key: string,
): SourceField {
  const scalars: Record<string, unknown> = {
    id: contact.id,
    firstName: contact.firstName,
    lastName: contact.lastName,
    fullName: [contact.firstName, contact.lastName].filter(Boolean).join(' '),
    email: contact.email,
    phone: contact.phone,
    companyName: contact.companyName,
    website: contact.website,
    address1: contact.address1,
    city: contact.city,
    state: contact.state,
    postalCode: contact.postalCode,
    country: contact.country,
    businessId: contact.businessId,
  };
  if (key in scalars) return { value: scalars[key], ghlType: 'scalar' };
  const def = catalog.byKey[key];
  if (def) {
    const cf = (contact.customFields ?? []).find((f) => f.id === def.id);
    return { value: cf?.value, ghlType: def.dataType, options: def.options };
  }
  return { value: undefined, ghlType: 'scalar' };
}

function normForCompare(v: unknown): unknown {
  if (v && typeof v === 'object' && '$date' in (v as any)) return String((v as any).$date).slice(0, 10);
  if (typeof v === 'string') {
    const s = v.trim();
    return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s.toLowerCase();
  }
  if (Array.isArray(v)) return [...v].map((x) => String(x)).sort();
  return v;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  const na = normForCompare(a);
  const nb = normForCompare(b);
  return JSON.stringify(na) === JSON.stringify(nb);
}

const sameIdSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');

/**
 * Apply a mapping row's `valueMap` (GHL label → Wix value) before coercion.
 *
 * Only for labels that are a genuinely different NAME on each side — casing and whitespace are
 * already handled by the reference resolver. Matching is case/whitespace-insensitive so the
 * configured key doesn't have to reproduce GHL's exact capitalization. Arrays are mapped
 * element-wise; anything unmapped passes through untouched.
 */
export function applyValueMap(value: unknown, valueMap: Record<string, string> | undefined): unknown {
  if (!valueMap || value == null) return value;
  const norm = (x: unknown) => String(x ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const lut = new Map<string, string>();
  for (const [k, v] of Object.entries(valueMap)) lut.set(norm(k), v);
  const one = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? lut.get(norm(v)) ?? v : v);
  return Array.isArray(value) ? value.map(one) : one(value);
}

/**
 * The companion column that records an image column's GHL SOURCE url, if the collection has one.
 * Convention: `<imageColumn>Src` (e.g. `logo` -> `logoSrc`, `image_fld` -> `image_fldSrc`).
 * Provision them with `scripts-ts/wix-image-guard-columns.ts`.
 */
export function imageSourceColumn(
  imageColumnKey: string,
  colById: Map<string, WixColumn>,
): string | undefined {
  const candidate = `${imageColumnKey}Src`;
  return colById.has(candidate) ? candidate : undefined;
}

export type ImagePlan =
  | { kind: 'unchanged' }
  | { kind: 'adopt' } // Wix already holds a file; stamp provenance without re-importing
  | { kind: 'import' }
  | { kind: 'blocked'; reason: string };

/**
 * Decide whether an image actually needs (re-)importing.
 *
 * With a companion column this is exact. Without one we refuse to re-import over an image that is
 * already present — churn is the bug being fixed, and a silent duplicate upload every run is worse
 * than a stale image that a `--force-images` run or a companion column resolves. A NEW row always
 * imports either way.
 */
export function planImageWrite(
  existing: unknown,
  imageColumnKey: string,
  companionColumn: string | undefined,
  sourceUrl: string,
  forceImages: boolean,
): ImagePlan {
  if (!existing) return { kind: 'import' }; // fresh insert: nothing to compare against
  const row = existing as Record<string, unknown>;
  const hasImage = row[imageColumnKey] != null && row[imageColumnKey] !== '';

  if (forceImages) return { kind: 'import' };

  if (companionColumn) {
    const recordedSource = row[companionColumn];
    if (typeof recordedSource === 'string' && recordedSource.trim() === sourceUrl.trim()) {
      return { kind: 'unchanged' };
    }
    // Image present but no provenance recorded (pre-guard rows): trust the existing file and
    // record where it came from, so the NEXT run is an exact comparison.
    if (hasImage && (recordedSource == null || recordedSource === '')) return { kind: 'adopt' };
    return { kind: 'import' };
  }

  if (hasImage) {
    return {
      kind: 'blocked',
      reason:
        `image already set and no \`${imageColumnKey}Src\` column to compare against — skipped to ` +
        `avoid a duplicate Media Manager upload. Add the companion column ` +
        `(scripts-ts/wix-image-guard-columns.ts) or re-run with forceImages.`,
    };
  }
  return { kind: 'import' };
}

/** Resolve reference labels to target item ids (needs the referenced collection's display field). */
async function resolveDesiredReferenceIds(
  col: WixColumn,
  labels: string[],
  client: WixClient,
): Promise<{ ids: string[]; unmatched: string[] }> {
  const refCollId = col.referencedCollectionId;
  if (!refCollId) throw new Error('missing referenced collection');
  const refSchema = await getCollectionSchema(refCollId, client);
  const displayField = refSchema.displayField ?? 'title';
  return resolveReferenceIds(refCollId, displayField, labels, client);
}

/** upsert = create-or-update · update = update-only · hide = de-provision · skip = pass by. */
type EngineAction = 'upsert' | 'update' | 'hide' | 'skip';

/**
 * The effective action for one record. If the set has a `gate`, the source status field maps to an
 * action (unlisted values => skip); otherwise the set's create policy governs unconditionally
 * (find_or_create => upsert, update_only => update) — i.e. no-gate sets behave exactly as before.
 */
function resolveAction(set: WixMappingSet, resolve: (key: string) => SourceField): { action: EngineAction; gateValue?: unknown } {
  if (set.gate) {
    const gateValue = resolve(set.gate.field).value;
    // Case-insensitive match: GHL SINGLE_OPTIONS reads back the lowercased option KEY (e.g. "published"),
    // while gate actions are usually keyed by the label ("Published"). Match either way.
    const key = gateValue == null ? '' : String(gateValue).toLowerCase();
    const lut: Record<string, GateAction> = {};
    for (const [k, v] of Object.entries(set.gate.actions)) lut[k.toLowerCase()] = v;
    return { action: (lut[key] ?? 'skip') as EngineAction, gateValue };
  }
  return { action: set.createPolicy === 'update_only' ? 'update' : 'upsert' };
}

/**
 * A source-object abstraction so the sync engine is object-agnostic: contacts and custom-object
 * records both provide a field resolver (value + GHL type + options) and a write-back. Everything
 * else (gate, match, coercion, upsert, visibility, dedup, write-back) is identical across objects.
 */
export interface SyncSource {
  objectKey: string;
  recordId: string;
  /**
   * Human name of the source record, for the change log. Supplied by the caller because the record
   * is already read there — the log used to show the raw GHL id, which told a reviewer nothing.
   */
  label?: string;
  resolve(key: string): SourceField;
  /** Write field changes back to the source record (id/status write-back). */
  writeFields(changes: Record<string, unknown>): Promise<void>;
}

/** Read a source field off a GHL objects-API record (business/custom_objects.*). 'id' => the record id. */
function resolveRecordField(objectKey: string, fields: { get(k: string): unknown; recordId: string }, catalog: CustomFieldCatalog, key: string): SourceField {
  if (key === 'id' || key === '_id') return { value: fields.recordId, ghlType: 'scalar' };
  const bare = key.replace(new RegExp(`^${objectKey.replace('.', '\\.')}\\.`), '');
  const def = catalog.byKey[key] ?? catalog.byKey[`${objectKey}.${bare}`];
  return { value: fields.get(key), ghlType: (def?.dataType as GhlSourceType) ?? 'scalar', options: def?.options };
}

/** Sync one GHL CONTACT into the mapping set's Wix collection (thin wrapper over the shared core). */
export async function syncContactToWix(
  contactId: string,
  set: WixMappingSet,
  catalog: CustomFieldCatalog,
  wixSchema: WixCollectionSchema,
  opts: { apply: boolean; client?: WixClient; ghlClient?: GhlClient; forceImages?: boolean },
): Promise<WixSyncResult> {
  const gclient = opts.ghlClient ?? ghl();
  const contact = await getContact(contactId, gclient);
  if (!contact) {
    return { sourceId: contactId, action: 'skip', written: [], unchanged: 0, skipped: [], dryRun: !opts.apply, note: 'source contact not found' };
  }
  const source: SyncSource = {
    objectKey: 'contact',
    recordId: contact.id,
    label: labelFromFields('contact', (k) => (contact as any)[k]),
    resolve: (key) => resolveContactField(contact, catalog, key),
    writeFields: async (changes) => { await writeRecordFields('contact', contact.id, changes, catalog, gclient); },
  };
  return syncSourceToWix(source, set, wixSchema, { apply: opts.apply, client: opts.client, forceImages: opts.forceImages });
}

/** Sync one GHL OBJECT RECORD (custom_objects.*, business) into the mapping set's Wix collection. */
export async function syncRecordToWix(
  objectKey: string,
  recordId: string,
  set: WixMappingSet,
  catalog: CustomFieldCatalog,
  wixSchema: WixCollectionSchema,
  opts: { apply: boolean; client?: WixClient; ghlClient?: GhlClient; forceImages?: boolean },
): Promise<WixSyncResult> {
  const gclient = opts.ghlClient ?? ghl();
  let fields: Awaited<ReturnType<typeof readRecordFields>>;
  try {
    fields = await readRecordFields(objectKey, recordId, gclient);
  } catch {
    return { sourceId: recordId, action: 'skip', written: [], unchanged: 0, skipped: [], dryRun: !opts.apply, note: 'source record not found' };
  }
  const source: SyncSource = {
    objectKey,
    recordId,
    label: labelFromFields(objectKey, (k) => fields.get(k)),
    resolve: (key) => resolveRecordField(objectKey, fields, catalog, key),
    writeFields: async (changes) => { await writeRecordFields(objectKey, recordId, changes, catalog, gclient); },
  };
  return syncSourceToWix(source, set, wixSchema, { apply: opts.apply, client: opts.client, forceImages: opts.forceImages });
}

/** The shared, object-agnostic core: sync one source record into the mapping set's Wix collection. */
export async function syncSourceToWix(
  source: SyncSource,
  set: WixMappingSet,
  wixSchema: WixCollectionSchema,
  opts: { apply: boolean; client?: WixClient; forceImages?: boolean },
): Promise<WixSyncResult> {
  const client = opts.client ?? wix();
  const contactId = source.recordId;
  const colById = new Map(wixSchema.columns.map((c) => [c.key, c] as const));

  // Gate: decide what to do with this record (status state machine, or the set's create policy).
  const { action: engineAction, gateValue } = resolveAction(set, source.resolve);
  if (engineAction === 'skip') {
    return { sourceId: contactId, action: 'skip', written: [], unchanged: 0, skipped: [], dryRun: !opts.apply,
      note: set.gate ? `gate: ${set.gate.field}="${gateValue ?? ''}" → skip` : 'update-only: nothing to do' };
  }

  const matchValue = source.resolve(set.matchSourceField).value;
  if (matchValue == null || matchValue === '') {
    return { sourceId: contactId, action: 'skip', written: [], unchanged: 0, skipped: [], dryRun: !opts.apply, note: `match field "${set.matchSourceField}" is empty` };
  }

  // Change-log sink for the Wix write path (Phase 1 covered GHL only). Records every real Wix row
  // write — insert / patch / hide — into the change_log, correlated by run_id when the caller wraps
  // the pipeline in withRun. Best-effort (logChange never throws); no-ops on a no-write result. Wrap
  // each write-return with this so the log captures the row id + field diffs + applied-vs-dryrun.
  const logWrite = async (result: WixSyncResult): Promise<WixSyncResult> => {
    const action = result.action === 'insert' ? 'create' : (result.action === 'patch' || result.action === 'hide') ? 'update' : null;
    if (action && result.written.length) {
      await logChange({
        app: 'wix', objectType: `wix:${set.name}`, recordId: result.itemId ?? '',
        // Human name first; the match value (a GHL id) is only a fallback now.
        recordLabel: source.label ?? String(matchValue),
        actorKind: 'sync', actorName: `wix:${set.name}`, action,
        changes: result.written.map((w) => ({ field: w.targetColumn, from: w.from, to: w.to })),
        method: 'sync', applied: !result.dryRun,
      });
    }
    return result;
  };

  // Inline the mapped reference columns' current targets so the reference guard below can compare
  // id sets without an extra round trip per field.
  const referenceColumns = set.rows
    .map((row) => colById.get(row.targetColumnKey))
    .filter((col): col is WixColumn => !!col && (String(col.type) === 'REFERENCE' || String(col.type) === 'MULTI_REFERENCE'))
    .map((col) => col.key);

  let existing = await queryItemByMatch(set.wixCollectionId, set.matchTargetColumn, String(matchValue), client, referenceColumns);

  // HIDE (gate flipped to Hidden / blank with a linked row): de-provision, keep the row + ids.
  if (engineAction === 'hide') {
    if (!existing) {
      return { sourceId: contactId, action: 'noop', written: [], unchanged: 0, skipped: [], dryRun: !opts.apply, note: 'hide: no linked row to hide' };
    }
    const itemId = (existing as any)._id as string | undefined;
    const vis = set.visibility;
    if (!vis) {
      return { sourceId: contactId, itemId, action: 'noop', written: [], unchanged: 0, skipped: [{ targetColumn: '(visibility)', reason: 'hide requested but no visibility configured' }], dryRun: !opts.apply };
    }
    if (vis.mode === 'publishState') {
      if (String((existing as any)._publishStatus) === 'DRAFT') {
        return { sourceId: contactId, itemId, action: 'noop', written: [], unchanged: 1, skipped: [], dryRun: !opts.apply, note: 'already hidden (draft)' };
      }
      const change: WixFieldChange = { targetColumn: '_publishStatus', from: (existing as any)._publishStatus, to: 'DRAFT', via: 'value' };
      if (opts.apply && itemId) await setPublishStatus(set.wixCollectionId, itemId, 'DRAFT', client);
      return logWrite({ sourceId: contactId, itemId, action: 'hide', written: [change], unchanged: 0, skipped: [], dryRun: !opts.apply });
    }
    // column mode
    const cur = (existing as any)[vis.column];
    if (valuesEqual(cur, vis.hiddenValue)) {
      return { sourceId: contactId, itemId, action: 'noop', written: [], unchanged: 1, skipped: [], dryRun: !opts.apply, note: 'already hidden' };
    }
    const change: WixFieldChange = { targetColumn: vis.column, from: cur, to: vis.hiddenValue, via: 'value' };
    if (opts.apply && itemId) await patchItem(set.wixCollectionId, itemId, [{ fieldPath: vis.column, value: vis.hiddenValue }], client);
    return logWrite({ sourceId: contactId, itemId, action: 'hide', written: [change], unchanged: 0, skipped: [], dryRun: !opts.apply });
  }

  // Dedup first-link: the hard key (ghl id) missed → try the configured secondary keys (e.g. email)
  // to ADOPT a pre-existing (possibly hand-made or drafted) row instead of creating a duplicate.
  // Exactly-one match adopts; >1 is ambiguous and defers to review (never auto-creates/merges).
  if (!existing && engineAction === 'upsert' && set.secondaryMatch?.length) {
    for (const sm of set.secondaryMatch) {
      const sv = source.resolve(sm.sourceField).value;
      if (sv == null || sv === '') continue;
      const hits = await queryItemsByColumn(set.wixCollectionId, sm.targetColumn, String(sv), 2, client, referenceColumns);
      if (hits.length > 1) {
        return { sourceId: contactId, action: 'skip', written: [], unchanged: 0, skipped: [], dryRun: !opts.apply,
          note: `dedup: ${sm.targetColumn}="${sv}" matched ${hits.length} rows → needs review (not created)` };
      }
      if (hits.length === 1) { existing = hits[0]; break; }
    }
  }

  const written: WixFieldChange[] = [];
  const skipped: Array<{ targetColumn: string; reason: string }> = [];
  let unchanged = 0;

  const valueMods: FieldModification[] = []; // plain-value changes (patch/insert body)
  const insertBody: Record<string, unknown> = {};
  const imageIntents: Array<{ col: string; sourceUrl: string; displayName?: string; companionColumn?: string }> = [];
  const refIntents: Array<{ col: WixColumn; labels: string[]; ids: string[]; unmatched: string[] }> = [];

  for (const row of set.rows) {
    const col = colById.get(row.targetColumnKey);
    if (!col) { skipped.push({ targetColumn: row.targetColumnKey, reason: 'column not on collection' }); continue; }
    if (isUnwritableWixType(String(col.type), col.systemField)) { skipped.push({ targetColumn: col.key, reason: `unwritable Wix type ${col.type}` }); continue; }

    const src = source.resolve(row.sourceFieldKey);
    // Rewrite labels that Wix names differently before coercing (e.g. "i4.0 Accelerator" →
    // "Industry 4.0 Accelerator"); without this those references resolve to nothing and drop out.
    const mapped = applyValueMap(src.value, row.valueMap);
    const result = coerceToWix(mapped, src.ghlType, String(col.type), row.transform, src.options);

    if (result.kind === 'skip') { if (result.reason !== 'empty') skipped.push({ targetColumn: col.key, reason: result.reason }); continue; }

    if (result.kind === 'value') {
      const current = existing ? (existing as any)[col.key] : undefined;
      if (existing && valuesEqual(current, result.value)) { unchanged++; continue; }
      written.push({ targetColumn: col.key, from: current, to: result.value, via: 'value' });
      valueMods.push({ fieldPath: col.key, value: result.value });
      insertBody[col.key] = result.value;
    } else if (result.kind === 'image') {
      // Equality-guarded via a companion source-url column, because Wix re-hosts the file on
      // import: the stored `wix:image://…` value can never be compared to the GHL source url, so
      // without a provenance marker every run re-imported the same file (126 duplicate Media
      // Manager uploads in the 13 days to 2026-08-17).
      const companion = imageSourceColumn(col.key, colById);
      const plan = planImageWrite(existing, col.key, companion, result.sourceUrl, !!opts.forceImages);
      if (plan.kind === 'unchanged') { unchanged++; continue; }
      if (plan.kind === 'blocked') { skipped.push({ targetColumn: col.key, reason: plan.reason }); continue; }
      if (plan.kind === 'adopt') {
        // Wix already holds the right file; just record its provenance so later runs are exact.
        written.push({ targetColumn: companion!, from: (existing as any)?.[companion!], to: result.sourceUrl, via: 'value' });
        valueMods.push({ fieldPath: companion!, value: result.sourceUrl });
        continue;
      }
      imageIntents.push({ col: col.key, sourceUrl: result.sourceUrl, displayName: result.displayName, companionColumn: companion });
      written.push({ targetColumn: col.key, to: result.sourceUrl, via: 'image' });
    } else if (result.kind === 'reference') {
      // Resolve to ids up front so we can compare against the row's CURRENT targets (read inline
      // via includeReferencedItems). Unguarded, replaceReferences fired on every run — 269 calls
      // in the same window — and a set mapping any reference could never report `noop`.
      let resolved: { ids: string[]; unmatched: string[] };
      try {
        resolved = await resolveDesiredReferenceIds(col, result.labels, client);
      } catch (e: any) {
        skipped.push({ targetColumn: col.key, reason: `reference resolve failed: ${e?.message ?? e}` });
        continue;
      }
      if (resolved.unmatched.length) skipped.push({ targetColumn: col.key, reason: `unmatched references: ${resolved.unmatched.join(', ')}` });
      if (!resolved.ids.length) continue;
      const currentIds = existing ? referencedIds((existing as any)[col.key]) : [];
      if (existing && sameIdSet(currentIds, resolved.ids)) { unchanged++; continue; }
      refIntents.push({ col, labels: result.labels, ids: resolved.ids, unmatched: resolved.unmatched });
      written.push({ targetColumn: col.key, from: currentIds, to: resolved.ids, via: 'reference' });
    }
  }

  // Update-only (gate 'update' / create_policy update_only): never create — nothing to update.
  if (!existing && engineAction === 'update') {
    return { sourceId: contactId, action: 'skip', written: [], unchanged, skipped, dryRun: !opts.apply, note: 'update-only: no existing row to update' };
  }

  // Visibility: a live upsert/update makes the row visible. publishState → ensure _publishStatus is
  // PUBLISHED (patched AFTER the upsert, since a fresh insert lands DRAFT); column → write the column.
  let needsPublish = false;
  if (set.visibility?.mode === 'column') {
    const vcur = existing ? (existing as any)[set.visibility.column] : undefined;
    if (!(existing && valuesEqual(vcur, set.visibility.visibleValue))) {
      written.push({ targetColumn: set.visibility.column, from: vcur, to: set.visibility.visibleValue, via: 'value' });
      valueMods.push({ fieldPath: set.visibility.column, value: set.visibility.visibleValue });
      insertBody[set.visibility.column] = set.visibility.visibleValue;
    }
  } else if (set.visibility?.mode === 'publishState') {
    const curStatus = existing ? String((existing as any)._publishStatus ?? '') : '';
    needsPublish = curStatus !== 'PUBLISHED'; // fresh insert (DRAFT) or currently hidden → publish
    if (needsPublish) written.push({ targetColumn: '_publishStatus', from: curStatus || 'DRAFT', to: 'PUBLISHED', via: 'value' });
  }

  // Always ensure the match key is present on inserts.
  insertBody[set.matchTargetColumn] = String(matchValue);

  // Adopted/legacy row missing the hard key → stamp it, so subsequent syncs match by id (idempotent).
  if (existing && String((existing as any)[set.matchTargetColumn] ?? '') !== String(matchValue)) {
    written.push({ targetColumn: set.matchTargetColumn, from: (existing as any)[set.matchTargetColumn], to: String(matchValue), via: 'value' });
    valueMods.push({ fieldPath: set.matchTargetColumn, value: String(matchValue) });
  }

  const action: WixSyncResult['action'] =
    written.length === 0 && existing ? 'noop' : existing ? 'patch' : 'insert';

  if (!opts.apply) {
    return logWrite({ sourceId: contactId, itemId: (existing as any)?._id, action, written, unchanged, skipped, dryRun: true });
  }

  // --- apply ---
  // 1) resolve image intents (import to Media Manager) into concrete field values, recording the
  //    GHL source url in the companion column so the next run can skip this entirely.
  for (const img of imageIntents) {
    try {
      const file = await importImageFromUrl(img.sourceUrl, { displayName: img.displayName }, client);
      const value = toImageFieldValue(file);
      valueMods.push({ fieldPath: img.col, value });
      insertBody[img.col] = value;
      if (img.companionColumn) {
        valueMods.push({ fieldPath: img.companionColumn, value: img.sourceUrl });
        insertBody[img.companionColumn] = img.sourceUrl;
      }
    } catch (e: any) {
      skipped.push({ targetColumn: img.col, reason: `image import failed: ${e?.message ?? e}` });
    }
  }

  // 2) upsert the plain-value + image fields.
  let itemId = (existing as any)?._id as string | undefined;
  if (existing && itemId) {
    if (valueMods.length) await patchItem(set.wixCollectionId, itemId, valueMods, client);
  } else {
    const created = await insertItem(set.wixCollectionId, insertBody, client);
    itemId = (created as any)?._id;
  }

  // 2b) publishState visibility: publish the row (a fresh insert lands DRAFT; a hidden row republishes).
  if (needsPublish && itemId) await setPublishStatus(set.wixCollectionId, itemId, 'PUBLISHED', client);

  // 3) reference intents — ids were resolved and diffed during planning, so anything still here
  //    is a genuine change. Needs the item id, which a fresh insert only just produced.
  for (const ref of refIntents) {
    if (!itemId) { skipped.push({ targetColumn: ref.col.key, reason: 'missing item id' }); continue; }
    try {
      await replaceReferences(set.wixCollectionId, itemId, ref.col.key, ref.ids, client);
    } catch (e: any) {
      skipped.push({ targetColumn: ref.col.key, reason: `reference write failed: ${e?.message ?? e}` });
    }
  }

  // ID write-back: stamp the Wix row id onto the GHL contact (e.g. contact.wix_team_row_id) — audit
  // trail + fast dedup guard + the hook a future Wix→GHL direction uses. Only when it differs.
  if (set.writebackField && itemId) {
    const current = source.resolve(set.writebackField).value;
    if (String(current ?? '') !== String(itemId)) {
      try {
        await source.writeFields({ [set.writebackField]: itemId });
      } catch (e: any) {
        skipped.push({ targetColumn: set.writebackField, reason: `id write-back failed: ${e?.message ?? e}` });
      }
    }
  }

  // Status write-back: after an approval publish (engineAction 'upsert'), advance the gate field to
  // its published value (e.g. Approved → Published). Loop-safe: 'Published' maps to 'update', which
  // doesn't write back, so it converges. Only when it actually differs.
  if (engineAction === 'upsert' && set.gate?.onPublishSetStatus && String(gateValue ?? '') !== set.gate.onPublishSetStatus) {
    try {
      await source.writeFields({ [set.gate.field]: set.gate.onPublishSetStatus });
    } catch (e: any) {
      skipped.push({ targetColumn: set.gate.field, reason: `status write-back failed: ${e?.message ?? e}` });
    }
  }

  return logWrite({ sourceId: contactId, itemId, action, written, unchanged, skipped, dryRun: false });
}
