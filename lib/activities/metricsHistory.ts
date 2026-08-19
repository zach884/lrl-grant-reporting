// lib/activities/metricsHistory.ts — a company's reported metrics, period by period.
//
// Zach, 2026-08-19: *"if the MEDC did a spot check and went 2 reporting periods back I want to pull
// those metrics easily instead of seeing data that has been overwritten since."*
//
// That is precisely what the per-period records buy. A GHL form overwrites the contact's fields on
// every submission, so the contact only ever shows the LATEST answers; each submission also becoming
// its own `metrics` activity (keyed `<contactId>:<periodEnd>`) means the earlier ones survive.
// This assembles them into the shape a spot check actually needs: one column per reporting period,
// newest first, and only the metrics that have ever been answered.

import { GhlClient, ghl } from '../ghl/client';
import { getCatalog } from '../ghl/catalogCache';
import { getRelatedRecordIds } from '../ghl/associations';
import { ACTIVITIES_OBJECT, activityFieldSet, bareKey } from './schema';
import { reportingPeriodFor } from './reportingPeriod';

export interface MetricsPeriod {
  /** Period end, YYYY-MM-DD — the record's `reporting_period`. */
  end: string;
  label: string;
  activityId: string;
}

export interface MetricsRow {
  key: string;
  label: string;
  /** periodEnd → the value reported for that period ('' when unanswered). */
  byPeriod: Record<string, string>;
}

export interface MetricsHistory {
  companyId: string;
  periods: MetricsPeriod[];
  rows: MetricsRow[];
}

const display = (v: unknown): string => {
  if (v == null || v === '') return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
};

/**
 * Every metrics snapshot for a company, as a period-by-period grid.
 *
 * Rows with no value in any period are dropped: a survey has 35 questions and a client answers a
 * handful, so showing all of them would bury the answers that exist.
 */
export async function metricsHistoryForCompany(
  companyId: string,
  client: GhlClient = ghl(),
): Promise<MetricsHistory> {
  const [ids, catalog] = await Promise.all([
    getRelatedRecordIds(companyId, ACTIVITIES_OBJECT, client),
    getCatalog(ACTIVITIES_OBJECT, { client }),
  ]);

  const records = await Promise.all(
    ids.map(async (id) => {
      try {
        const data = await client.request<any>({ path: `/objects/${ACTIVITIES_OBJECT}/records/${id}` });
        return data.record ?? data;
      } catch {
        return null;
      }
    }),
  );

  const snapshots = records
    .filter((r) => r && (r.properties ?? {}).activity_type === 'metrics')
    .map((r) => ({ id: r.id, props: (r.properties ?? {}) as Record<string, unknown> }));

  const periods: MetricsPeriod[] = snapshots
    .map((s) => {
      const end = String(s.props.reporting_period ?? '').slice(0, 10);
      // A snapshot written before the period was derived still sorts and labels correctly.
      const label = end ? reportingPeriodFor(`${end}T12:00:00Z`).label : 'Unknown period';
      return { end, label, activityId: s.id };
    })
    .filter((p) => p.end)
    .sort((a, b) => b.end.localeCompare(a.end));

  const set = activityFieldSet(catalog, 'metrics');
  const rows: MetricsRow[] = [];
  for (const f of set.typeFields) {
    const key = bareKey(f);
    if (key === 'reporting_period') continue;
    const byPeriod: Record<string, string> = {};
    let any = false;
    for (const s of snapshots) {
      const end = String(s.props.reporting_period ?? '').slice(0, 10);
      if (!end) continue;
      const v = display(s.props[key]);
      byPeriod[end] = v;
      if (v) any = true;
    }
    if (any) rows.push({ key, label: f.name, byPeriod });
  }

  return { companyId, periods, rows };
}
