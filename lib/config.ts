// lib/config.ts — Config sheet reader with 5-minute cache

import { sheets } from './sheets';
import type {
  ConfigData,
  ReferralTypeGrantMapping,
  GrantSheetMapping,
  FieldMapping,
  ReportingPeriod,
} from '@/types';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CONFIG_SHEET_ID = process.env.CONFIG_SHEET_ID!;

let cache: ConfigData | null = null;
let cacheTimestamp: number = 0;

export async function getConfig(forceRefresh = false): Promise<ConfigData> {
  if (!forceRefresh && cache && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cache;
  }
  cache = await loadConfigFromSheet();
  cacheTimestamp = Date.now();
  return cache;
}

export function clearConfigCache(): void {
  cache = null;
  cacheTimestamp = 0;
}

async function loadConfigFromSheet(): Promise<ConfigData> {
  // Fetch all 4 active tabs in a single batchGet call
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: CONFIG_SHEET_ID,
    ranges: [
      'referral_type_grant_mapping',
      'grant_sheet_mapping',
      'field_mapping',
      'reporting_periods',
    ],
  });

  const valueRanges = response.data.valueRanges ?? [];

  return {
    referralTypeGrantMapping: parseReferralTypeGrantMapping(valueRanges[0]?.values ?? []),
    grantSheetMapping: parseGrantSheetMapping(valueRanges[1]?.values ?? []),
    fieldMapping: parseFieldMapping(valueRanges[2]?.values ?? []),
    reportingPeriods: parseReportingPeriods(valueRanges[3]?.values ?? []),
  };
}

// --- Parsers: skip header row (index 0), map each data row by column position ---

function parseReferralTypeGrantMapping(rows: string[][]): ReferralTypeGrantMapping[] {
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((row) => ({
    referral_type_key: getCol(row, headers, 'referral_type_key'),
    display_label: getCol(row, headers, 'display_label'),
    grant: getCol(row, headers, 'grant'),
    grant_reporting_label: getCol(row, headers, 'grant_reporting_label'),
  }));
}

function parseGrantSheetMapping(rows: string[][]): GrantSheetMapping[] {
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((row) => ({
    grant: getCol(row, headers, 'grant'),
    activity_type_key: getCol(row, headers, 'activity_type_key'),
    sheet_id: getCol(row, headers, 'sheet_id'),
    active: getCol(row, headers, 'active').toUpperCase() === 'TRUE',
  }));
}

function parseFieldMapping(rows: string[][]): FieldMapping[] {
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((row) => ({
    grant: getCol(row, headers, 'grant'),
    activity_type_key: getCol(row, headers, 'activity_type_key'),
    sheet_id: getCol(row, headers, 'sheet_id'),
    column_letter: getCol(row, headers, 'column_letter'),
    data_source: getCol(row, headers, 'data_source') as FieldMapping['data_source'],
    field_key: getCol(row, headers, 'field_key'),
    display_label: getCol(row, headers, 'display_label'),
    write_condition: getCol(row, headers, 'write_condition'),
    header_row: parseInt(getCol(row, headers, 'header_row') || '1', 10),
  }));
}

function parseReportingPeriods(rows: string[][]): ReportingPeriod[] {
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((row) => ({
    grant: getCol(row, headers, 'grant'),
    period_label: getCol(row, headers, 'period_label'),
    sheet_id: getCol(row, headers, 'sheet_id'),
    tab_name: getCol(row, headers, 'tab_name'),
    date_from: getCol(row, headers, 'date_from'),
    date_to: getCol(row, headers, 'date_to'),
    active: getCol(row, headers, 'active').toUpperCase() === 'TRUE',
  }));
}

/** Safe column accessor — matches header name to index, returns '' if missing */
function getCol(row: string[], headers: string[], name: string): string {
  const idx = headers.indexOf(name);
  if (idx === -1) return '';
  return (row[idx] ?? '').trim();
}
