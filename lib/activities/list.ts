// lib/activities/list.ts — read activities back out, as a company timeline or a recent feed.
//
// Activities carry no company id in their properties; the company link lives in the ASSOCIATION
// graph (`company_activity`). So a company timeline is: relations → activity ids → read each record.
// That is a read per activity, which is fine at the scale of one company's history and is the only
// correct source — deriving the company from `activity_name` (what v1 did, by splitting the string
// on an en dash) breaks the moment anyone edits the name.
//
// The recent feed uses the records search endpoint instead, sorted by GHL's own `updatedAt`.

import { GhlClient, ghl } from '../ghl/client';
import { getRelatedRecordIds } from '../ghl/associations';
import { getCatalog } from '../ghl/catalogCache';
import type { CustomFieldCatalog } from '../ghl/types';
import { ACTIVITIES_OBJECT, activityType } from './schema';

export interface ActivitySummary {
  id: string;
  type: string;
  /** Human label for the type ("Technical Assistance"), or the raw key if unrecognized. */
  typeLabel: string;
  name: string;
  date: string;
  owner: string;
  notes: string;
  /** Type-specific fields as [label, displayValue], in the type's field order. */
  details: Array<{ key: string; label: string; value: string }>;
  updatedAt?: string;
}

/** Stored value → something readable, resolving option keys to their labels via the catalog. */
function display(value: unknown, key: string, catalog: CustomFieldCatalog): string {
  if (value == null || value === '') return '';
  const def = catalog.byKey[`${ACTIVITIES_OBJECT}.${key}`] ?? catalog.byKey[key];
  const label = (v: unknown) => {
    const hit = def?.options?.find((o) => o.key === String(v) || o.label === String(v));
    return hit?.label ?? String(v);
  };
  if (Array.isArray(value)) return value.map(label).join(', ');
  if (def?.dataType === 'DATE') return String(value).slice(0, 10);
  return label(value);
}

const CORE_KEYS = new Set(['activity_type', 'activity_name', 'activity_date', 'activity_owner', 'activity_notes']);

export function toSummary(
  record: { id: string; properties?: Record<string, unknown>; updatedAt?: string },
  catalog: CustomFieldCatalog,
): ActivitySummary {
  const p = record.properties ?? {};
  const type = String(p.activity_type ?? '');
  const def = activityType(type);
  // Show whatever this record actually carries beyond the core fields — which makes grant and
  // metrics records (form-fed, not staff-logged) readable in the timeline without a form for them.
  const details = Object.entries(p)
    .filter(([k, v]) => !CORE_KEYS.has(k) && v != null && v !== '' && !(Array.isArray(v) && v.length === 0))
    .map(([k]) => {
      const fd = catalog.byKey[`${ACTIVITIES_OBJECT}.${k}`] ?? catalog.byKey[k];
      return { key: k, label: fd?.name ?? k, value: display(p[k], k, catalog) };
    })
    .filter((d) => d.value !== '');
  return {
    id: record.id,
    type,
    typeLabel: def?.label ?? type,
    name: String(p.activity_name ?? ''),
    date: String(p.activity_date ?? '').slice(0, 10),
    owner: String(p.activity_owner ?? ''),
    notes: String(p.activity_notes ?? ''),
    details,
    updatedAt: record.updatedAt,
  };
}

async function readRecord(recordId: string, client: GhlClient): Promise<any | null> {
  try {
    const data = await client.request<any>({ path: `/objects/${ACTIVITIES_OBJECT}/records/${recordId}` });
    return data.record ?? data;
  } catch {
    return null; // a deleted record still shows up as a relation for a while
  }
}

const byDateDesc = (a: ActivitySummary, b: ActivitySummary) =>
  (b.date || '').localeCompare(a.date || '') || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');

/** One company's activity timeline, newest first. All types, including form-fed grant/metrics. */
export async function listActivitiesForCompany(
  companyId: string,
  client: GhlClient = ghl(),
): Promise<ActivitySummary[]> {
  const [ids, catalog] = await Promise.all([
    getRelatedRecordIds(companyId, ACTIVITIES_OBJECT, client),
    getCatalog(ACTIVITIES_OBJECT, { client }),
  ]);
  const records = await Promise.all(ids.map((id) => readRecord(id, client)));
  return records
    .filter(Boolean)
    .map((r) => toSummary(r, catalog))
    .sort(byDateDesc);
}

/** The most recently touched activities across all companies (the "what's been logged" feed). */
export async function listRecentActivities(
  limit = 50,
  client: GhlClient = ghl(),
): Promise<ActivitySummary[]> {
  const catalog = await getCatalog(ACTIVITIES_OBJECT, { client });
  const data = await client.request<any>({
    method: 'POST',
    path: `/objects/${ACTIVITIES_OBJECT}/records/search`,
    autoLocation: false,
    body: {
      locationId: client.locationId,
      query: '',
      page: 1,
      pageLimit: Math.min(limit, 100),
      searchAfter: [],
      sort: [{ field: 'updatedAt', direction: 'desc' }],
    },
  });
  const records: any[] = data.records ?? data.data ?? [];
  return records.map((r) => toSummary(r, catalog));
}
